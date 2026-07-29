import pg from "pg";



const { Pool } = pg;



const REQUIRED_ENVIRONMENT_VARIABLES = [

  "DB_HOST",

  "DB_PORT",

  "DB_NAME",

  "DB_USER",

  "DB_PASSWORD",

];



for (const variableName of REQUIRED_ENVIRONMENT_VARIABLES) {

  if (!process.env[variableName]) {

    throw new Error(

      `Missing required environment variable: ${variableName}`,

    );

  }

}



const HOURLY_RATE = Number(

  process.env.HOURLY_RATE ?? "20",

);



const OCR_REVIEW_THRESHOLD = Number(

  process.env.OCR_REVIEW_THRESHOLD ?? "70",

);



if (!Number.isFinite(HOURLY_RATE) || HOURLY_RATE < 0) {

  throw new Error(

    "HOURLY_RATE must be a valid non-negative number.",

  );

}



if (

  !Number.isFinite(OCR_REVIEW_THRESHOLD) ||

  OCR_REVIEW_THRESHOLD < 0 ||

  OCR_REVIEW_THRESHOLD > 100

) {

  throw new Error(

    "OCR_REVIEW_THRESHOLD must be between 0 and 100.",

  );

}



const pool = new Pool({

  host: process.env.DB_HOST,

  port: Number(process.env.DB_PORT),

  database: process.env.DB_NAME,

  user: process.env.DB_USER,

  password: process.env.DB_PASSWORD,



  ssl: {

    rejectUnauthorized: false,

  },



  max: 1,

  idleTimeoutMillis: 10000,

  connectionTimeoutMillis: 10000,

  allowExitOnIdle: true,

});



pool.on("error", (error) => {

  console.error(

    "Unexpected PostgreSQL pool error:",

    error,

  );

});



class ApplicationError extends Error {

  constructor(statusCode, message) {

    super(message);



    this.name = "ApplicationError";

    this.statusCode = statusCode;

  }

}



function createResponse(statusCode, body) {

  return {

    statusCode,

    headers: {

      "Content-Type": "application/json",

    },

    body: JSON.stringify(body),

  };

}



function normalisePlateNumber(value = "") {

  return value

    .toUpperCase()

    .replace(/[^A-Z0-9]/g, "");

}



function validatePlateNumber(value) {

  const plateNumber = normalisePlateNumber(value);



  if (

    plateNumber.length < 4 ||

    plateNumber.length > 15

  ) {

    throw new ApplicationError(

      400,

      "The licence plate must contain between 4 and 15 letters or numbers.",

    );

  }



  return plateNumber;

}



function validateImageKey(value) {

  if (

    typeof value !== "string" ||

    value.trim().length === 0

  ) {

    throw new ApplicationError(

      400,

      "A valid S3 image key is required.",

    );

  }



  return value.trim();

}



function parseConfidence(value) {

  if (

    value === undefined ||

    value === null ||

    value === ""

  ) {

    return null;

  }



  const confidence = Number(value);



  if (

    !Number.isFinite(confidence) ||

    confidence < 0 ||

    confidence > 100

  ) {

    throw new ApplicationError(

      400,

      "OCR confidence must be between 0 and 100.",

    );

  }



  return Number(confidence.toFixed(2));

}



function requiresManualReview(confidence) {

  return (

    confidence === null ||

    confidence < OCR_REVIEW_THRESHOLD

  );

}



function createReceiptNumber(

  sessionId,

  exitTimestamp,

) {

  const datePart = exitTimestamp

    .toISOString()

    .slice(0, 10)

    .replace(/-/g, "");



  const sessionPart = sessionId

    .replace(/-/g, "")

    .slice(0, 12)

    .toUpperCase();



  return `PF-${datePart}-${sessionPart}`;

}



async function initialiseDatabase() {

  await pool.query(`

    CREATE TABLE IF NOT EXISTS parking_sessions (

      session_id UUID

        PRIMARY KEY

        DEFAULT gen_random_uuid(),



      license_plate VARCHAR(15) NOT NULL,



      entry_image_key TEXT NOT NULL,

      exit_image_key TEXT,



      entry_timestamp TIMESTAMP WITH TIME ZONE

        NOT NULL DEFAULT CURRENT_TIMESTAMP,



      exit_timestamp TIMESTAMP WITH TIME ZONE,



      session_status VARCHAR(20)

        NOT NULL DEFAULT 'ACTIVE',



      calculated_fee DECIMAL(8, 2)

        NOT NULL DEFAULT 0.00,



      entry_ocr_confidence DECIMAL(5, 2),

      exit_ocr_confidence DECIMAL(5, 2),



      created_at TIMESTAMP WITH TIME ZONE

        NOT NULL DEFAULT CURRENT_TIMESTAMP,



      updated_at TIMESTAMP WITH TIME ZONE

        NOT NULL DEFAULT CURRENT_TIMESTAMP,



      CONSTRAINT valid_session_status

        CHECK (

          session_status IN (

            'ACTIVE',

            'COMPLETED',

            'FLAGGED'

          )

        ),



      CONSTRAINT non_negative_fee

        CHECK (calculated_fee >= 0)

    );

  `);



  /*

   * These columns are added to your existing table.

   * IF NOT EXISTS prevents errors when init is run again.

   */

  await pool.query(`

    ALTER TABLE parking_sessions

    ADD COLUMN IF NOT EXISTS

      duration_minutes INTEGER;

  `);



  await pool.query(`

    ALTER TABLE parking_sessions

    ADD COLUMN IF NOT EXISTS

      hourly_rate DECIMAL(8, 2);

  `);



  await pool.query(`

    ALTER TABLE parking_sessions

    ADD COLUMN IF NOT EXISTS

      receipt_number VARCHAR(50);

  `);



  await pool.query(`

    ALTER TABLE parking_sessions

    ADD COLUMN IF NOT EXISTS

      review_required BOOLEAN

      NOT NULL DEFAULT FALSE;

  `);



  await pool.query(

    `

      UPDATE parking_sessions

      SET hourly_rate = $1

      WHERE hourly_rate IS NULL;

    `,

    [HOURLY_RATE],

  );



  await pool.query(`

    CREATE INDEX IF NOT EXISTS

      idx_parking_sessions_status

    ON parking_sessions (session_status);

  `);



  await pool.query(`

    CREATE INDEX IF NOT EXISTS

      idx_parking_sessions_plate

    ON parking_sessions (license_plate);

  `);



  await pool.query(`

    CREATE INDEX IF NOT EXISTS

      idx_parking_sessions_entry_time

    ON parking_sessions (entry_timestamp DESC);

  `);



  await pool.query(`

    CREATE UNIQUE INDEX IF NOT EXISTS

      unique_active_session_per_plate

    ON parking_sessions (license_plate)

    WHERE session_status = 'ACTIVE';

  `);



  await pool.query(`

    CREATE UNIQUE INDEX IF NOT EXISTS

      unique_receipt_number

    ON parking_sessions (receipt_number)

    WHERE receipt_number IS NOT NULL;

  `);



  return {

    message: "Database initialised successfully.",

    table: "parking_sessions",

    hourlyRate: HOURLY_RATE,

    currency: "ZAR",

  };

}



async function runHealthCheck() {

  const result = await pool.query(`

    SELECT

      CURRENT_DATABASE() AS database_name,

      CURRENT_TIMESTAMP AS checked_at;

  `);



  return {

    message: "Database connection successful.",

    connection: result.rows[0],

  };

}



async function createEntrySession(event) {

  const plateNumber = validatePlateNumber(

    event.plateNumber,

  );



  const imageKey = validateImageKey(

    event.imageKey,

  );



  const confidence = parseConfidence(

    event.confidence,

  );



  const reviewRequired =

    requiresManualReview(confidence);



  const result = await pool.query(

    `

      INSERT INTO parking_sessions (

        license_plate,

        entry_image_key,

        session_status,

        hourly_rate,

        entry_ocr_confidence,

        review_required

      )

      VALUES (

        $1,

        $2,

        'ACTIVE',

        $3,

        $4,

        $5

      )

      RETURNING

        session_id,

        license_plate,

        entry_image_key,

        entry_timestamp,

        session_status,

        hourly_rate::DOUBLE PRECISION

          AS hourly_rate,

        entry_ocr_confidence::DOUBLE PRECISION

          AS entry_ocr_confidence,

        review_required;

    `,

    [

      plateNumber,

      imageKey,

      HOURLY_RATE,

      confidence,

      reviewRequired,

    ],

  );



  return {

    message: "Parking entry session created.",

    session: result.rows[0],

  };

}



async function completeExitSession(event) {

  const plateNumber = validatePlateNumber(

    event.plateNumber,

  );



  const imageKey = validateImageKey(

    event.imageKey,

  );



  const confidence = parseConfidence(

    event.confidence,

  );



  const client = await pool.connect();



  try {

    await client.query("BEGIN");



    const activeSessionResult =

      await client.query(

        `

          SELECT

            session_id,

            license_plate,

            entry_timestamp,

            hourly_rate,

            review_required

          FROM parking_sessions

          WHERE license_plate = $1

            AND session_status = 'ACTIVE'

          ORDER BY entry_timestamp ASC

          LIMIT 1

          FOR UPDATE;

        `,

        [plateNumber],

      );



    if (activeSessionResult.rowCount === 0) {

      throw new ApplicationError(

        404,

        `No active parking session was found for ${plateNumber}.`,

      );

    }



    const activeSession =

      activeSessionResult.rows[0];



    const entryTimestamp = new Date(

      activeSession.entry_timestamp,

    );



    const exitTimestamp = new Date();



    const durationMilliseconds =

      exitTimestamp.getTime() -

      entryTimestamp.getTime();



    const durationMinutes = Math.max(

      1,

      Math.ceil(

        durationMilliseconds / 60000,

      ),

    );



    const sessionHourlyRate = Number(

      activeSession.hourly_rate ??

        HOURLY_RATE,

    );



    const calculatedFee = Number(

      (

        (durationMinutes / 60) *

        sessionHourlyRate

      ).toFixed(2),

    );



    const reviewRequired =

      Boolean(activeSession.review_required) ||

      requiresManualReview(confidence);



    const receiptNumber =

      createReceiptNumber(

        activeSession.session_id,

        exitTimestamp,

      );



    const completedSessionResult =

      await client.query(

        `

          UPDATE parking_sessions

          SET

            exit_image_key = $1,

            exit_timestamp = $2,

            duration_minutes = $3,

            calculated_fee = $4,

            exit_ocr_confidence = $5,

            review_required = $6,

            receipt_number = $7,

            session_status = 'COMPLETED',

            updated_at = CURRENT_TIMESTAMP

          WHERE session_id = $8

          RETURNING

            session_id,

            license_plate,

            entry_image_key,

            exit_image_key,

            entry_timestamp,

            exit_timestamp,

            duration_minutes,

            hourly_rate::DOUBLE PRECISION

              AS hourly_rate,

            calculated_fee::DOUBLE PRECISION

              AS calculated_fee,

            session_status,

            receipt_number,

            entry_ocr_confidence::DOUBLE PRECISION

              AS entry_ocr_confidence,

            exit_ocr_confidence::DOUBLE PRECISION

              AS exit_ocr_confidence,

            review_required;

        `,

        [

          imageKey,

          exitTimestamp,

          durationMinutes,

          calculatedFee,

          confidence,

          reviewRequired,

          receiptNumber,

          activeSession.session_id,

        ],

      );



    await client.query("COMMIT");



    return {

      message: "Parking exit completed.",

      session:

        completedSessionResult.rows[0],

      receipt: {

        receiptNumber,

        currency: "ZAR",

        hourlyRate: sessionHourlyRate,

        durationMinutes,

        totalFee: calculatedFee,

      },

    };

  } catch (error) {

    await client.query("ROLLBACK");

    throw error;

  } finally {

    client.release();

  }

}



async function listParkingSessions(event) {

  const requestedLimit = Number(

    event.limit ?? 50,

  );



  const limit = Number.isInteger(

    requestedLimit,

  )

    ? Math.min(

        Math.max(requestedLimit, 1),

        100,

      )

    : 50;



  const result = await pool.query(

    `

      SELECT

        session_id,

        license_plate,

        entry_image_key,

        exit_image_key,

        entry_timestamp,

        exit_timestamp,

        duration_minutes,

        hourly_rate::DOUBLE PRECISION

          AS hourly_rate,

        calculated_fee::DOUBLE PRECISION

          AS calculated_fee,

        session_status,

        receipt_number,

        entry_ocr_confidence::DOUBLE PRECISION

          AS entry_ocr_confidence,

        exit_ocr_confidence::DOUBLE PRECISION

          AS exit_ocr_confidence,

        review_required

      FROM parking_sessions

      ORDER BY entry_timestamp DESC

      LIMIT $1;

    `,

    [limit],

  );



  return {

    count: result.rowCount,

    sessions: result.rows,

  };

}



export const handler = async (

  event = {},

  context,

) => {

  if (context) {

    context.callbackWaitsForEmptyEventLoop =

      false;

  }



  const action =

    event.action ?? "health";



  console.log(

    "Database action received:",

    action,

  );



  try {

    let result;



    switch (action) {

      case "init":

        result =

          await initialiseDatabase();

        break;



      case "health":

        result =

          await runHealthCheck();

        break;



      case "entry":

        result =

          await createEntrySession(event);

        break;



      case "exit":

        result =

          await completeExitSession(event);

        break;



      case "list":

        result =

          await listParkingSessions(event);

        break;



      default:

        throw new ApplicationError(

          400,

          "Unsupported database action.",

        );

    }



    return createResponse(200, result);

  } catch (error) {

    console.error(

      "Database operation failed:",

      error,

    );



    if (error.code === "23505") {

      return createResponse(409, {

        message:

          "This vehicle already has an active parking session.",

      });

    }



    const statusCode =

      error instanceof ApplicationError

        ? error.statusCode

        : 500;



    return createResponse(statusCode, {

      message:

        error instanceof ApplicationError

          ? error.message

          : "Database operation failed.",

      error:

        statusCode === 500

          ? error.message

          : undefined,

    });

  }

};