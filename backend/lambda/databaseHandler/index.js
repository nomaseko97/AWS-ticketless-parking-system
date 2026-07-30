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
    throw new Error(`Missing required environment variable: ${variableName}`);
  }
}

const HOURLY_RATE = Number(process.env.HOURLY_RATE ?? "20");

const OCR_REVIEW_THRESHOLD = Number(process.env.OCR_REVIEW_THRESHOLD ?? "70");

if (!Number.isFinite(HOURLY_RATE) || HOURLY_RATE < 0) {
  throw new Error("HOURLY_RATE must be a valid non-negative number.");
}

if (
  !Number.isFinite(OCR_REVIEW_THRESHOLD) ||
  OCR_REVIEW_THRESHOLD < 0 ||
  OCR_REVIEW_THRESHOLD > 100
) {
  throw new Error("OCR_REVIEW_THRESHOLD must be between 0 and 100.");
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
  console.error("Unexpected PostgreSQL pool error:", error);
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
  return String(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function validatePlateNumber(value) {
  const plateNumber = normalisePlateNumber(value);

  if (plateNumber.length < 4 || plateNumber.length > 15) {
    throw new ApplicationError(
      400,
      "The licence plate must contain between 4 and 15 letters or numbers.",
    );
  }

  return plateNumber;
}

function validateImageKey(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApplicationError(400, "A valid S3 image key is required.");
  }

  return value.trim();
}

function parseConfidence(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const confidence = Number(value);

  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
    throw new ApplicationError(
      400,
      "OCR confidence must be between 0 and 100.",
    );
  }

  return Number(confidence.toFixed(2));
}

function requiresManualReview(confidence) {
  return confidence === null || confidence < OCR_REVIEW_THRESHOLD;
}

function createReceiptNumber(sessionId, exitTimestamp) {
  const datePart = exitTimestamp.toISOString().slice(0, 10).replace(/-/g, "");

  const sessionPart = sessionId.replace(/-/g, "").slice(0, 12).toUpperCase();

  return `PF-${datePart}-${sessionPart}`;
}

async function saveProcessingResult({
  imageKey,
  operation,
  plateNumber = null,
  processingStatus,
  message,
  httpStatus,
}) {
  if (!imageKey) {
    console.warn(
      "Processing result was not stored because imageKey is missing.",
    );

    return null;
  }

  /*
   * A SUCCESS result is final. S3 can deliver the same event more than once,
   * so a later duplicate attempt must never replace SUCCESS with REJECTED
   * or FAILED.
   */
  const result = await pool.query(
    `
      INSERT INTO processing_results (
        image_key,
        operation,
        plate_number,
        processing_status,
        result_message,
        http_status,
        updated_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        CURRENT_TIMESTAMP
      )

      ON CONFLICT (image_key)
      DO UPDATE SET
        operation = EXCLUDED.operation,
        plate_number = COALESCE(
          EXCLUDED.plate_number,
          processing_results.plate_number
        ),
        processing_status = EXCLUDED.processing_status,
        result_message = EXCLUDED.result_message,
        http_status = EXCLUDED.http_status,
        updated_at = CURRENT_TIMESTAMP

      WHERE
        processing_results.processing_status <> 'SUCCESS'
        OR EXCLUDED.processing_status = 'SUCCESS'

      RETURNING
        result_id,
        image_key,
        operation,
        plate_number,
        processing_status,
        result_message,
        http_status,
        created_at,
        updated_at;
    `,
    [imageKey, operation, plateNumber, processingStatus, message, httpStatus],
  );

  if (result.rowCount === 0) {
    const existingResult = await pool.query(
      `
        SELECT
          result_id,
          image_key,
          operation,
          plate_number,
          processing_status,
          result_message,
          http_status,
          created_at,
          updated_at
        FROM processing_results
        WHERE image_key = $1
        LIMIT 1;
      `,
      [imageKey],
    );

    console.log(
      "Existing successful processing result preserved:",
      JSON.stringify(existingResult.rows[0]),
    );

    return existingResult.rows[0] ?? null;
  }

  console.log("Processing result stored:", JSON.stringify(result.rows[0]));

  return result.rows[0];
}

async function claimProcessing(event) {
  const imageKey = validateImageKey(event.imageKey);

  const operation =
    event.operation === "entry" || event.operation === "exit"
      ? event.operation
      : "unknown";

  const insertResult = await pool.query(
    `
      INSERT INTO processing_results (
        image_key,
        operation,
        plate_number,
        processing_status,
        result_message,
        http_status,
        updated_at
      )
      VALUES (
        $1,
        $2,
        NULL,
        'PENDING',
        'The licence plate image is still being processed.',
        202,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT (image_key) DO NOTHING
      RETURNING
        result_id,
        image_key,
        operation,
        plate_number,
        processing_status,
        result_message,
        http_status,
        created_at,
        updated_at;
    `,
    [imageKey, operation],
  );

  if (insertResult.rowCount === 1) {
    return {
      shouldProcess: true,
      existingResult: insertResult.rows[0],
    };
  }

  const existingResult = await pool.query(
    `
      SELECT
        result_id,
        image_key,
        operation,
        plate_number,
        processing_status,
        result_message,
        http_status,
        created_at,
        updated_at
      FROM processing_results
      WHERE image_key = $1
      LIMIT 1;
    `,
    [imageKey],
  );

  return {
    shouldProcess: false,
    existingResult: existingResult.rows[0] ?? null,
  };
}

async function recordProcessingResult(event) {
  const imageKey = validateImageKey(event.imageKey);

  const operation =
    event.operation === "entry" || event.operation === "exit"
      ? event.operation
      : "unknown";

  const allowedStatuses = new Set(["PENDING", "SUCCESS", "REJECTED", "FAILED"]);

  const processingStatus = String(event.processingStatus ?? "").toUpperCase();

  if (!allowedStatuses.has(processingStatus)) {
    throw new ApplicationError(400, "Invalid processing status.");
  }

  const message =
    typeof event.message === "string" && event.message.trim()
      ? event.message.trim()
      : "The parking operation could not be completed. Please try again.";

  const httpStatus = Number(event.httpStatus ?? 500);

  return saveProcessingResult({
    imageKey,
    operation,
    plateNumber: event.plateNumber
      ? normalisePlateNumber(event.plateNumber)
      : null,
    processingStatus,
    message,
    httpStatus: Number.isInteger(httpStatus) ? httpStatus : 500,
  });
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
        CHECK (calculated_fee >= 0),

      CONSTRAINT valid_entry_confidence
        CHECK (
          entry_ocr_confidence IS NULL
          OR (
            entry_ocr_confidence >= 0
            AND entry_ocr_confidence <= 100
          )
        ),

      CONSTRAINT valid_exit_confidence
        CHECK (
          exit_ocr_confidence IS NULL
          OR (
            exit_ocr_confidence >= 0
            AND exit_ocr_confidence <= 100
          )
        )
    );
  `);

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
    ON parking_sessions (
      entry_timestamp DESC
    );
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS processing_results (
      result_id UUID
        PRIMARY KEY
        DEFAULT gen_random_uuid(),

      image_key TEXT
        NOT NULL UNIQUE,

      operation VARCHAR(20)
        NOT NULL,

      plate_number VARCHAR(15),

      processing_status VARCHAR(20)
        NOT NULL,

      result_message TEXT
        NOT NULL,

      http_status INTEGER
        NOT NULL,

      created_at TIMESTAMP WITH TIME ZONE
        NOT NULL DEFAULT CURRENT_TIMESTAMP,

      updated_at TIMESTAMP WITH TIME ZONE
        NOT NULL DEFAULT CURRENT_TIMESTAMP,

      CONSTRAINT valid_processing_operation
        CHECK (
          operation IN (
            'entry',
            'exit',
            'unknown'
          )
        ),

      CONSTRAINT valid_processing_status
        CHECK (
          processing_status IN (
            'PENDING',
            'SUCCESS',
            'REJECTED',
            'FAILED'
          )
        )
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
      idx_processing_results_status
    ON processing_results (
      processing_status
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
      idx_processing_results_updated
    ON processing_results (
      updated_at DESC
    );
  `);

  return {
    message: "Database initialised successfully.",

    tables: ["parking_sessions", "processing_results"],

    hourlyRate: HOURLY_RATE,
    currency: "ZAR",
  };
}

async function runHealthCheck() {
  const result = await pool.query(`
    SELECT
      CURRENT_DATABASE()
        AS database_name,

      CURRENT_TIMESTAMP
        AS checked_at;
  `);

  return {
    message: "Database connection successful.",

    connection: result.rows[0],
  };
}

async function createEntrySession(event) {
  const plateNumber = validatePlateNumber(event.plateNumber);

  const imageKey = validateImageKey(event.imageKey);

  const confidence = parseConfidence(event.confidence);

  const reviewRequired = requiresManualReview(confidence);

  console.log(`Creating entry session for ${plateNumber}.`);

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
    [plateNumber, imageKey, HOURLY_RATE, confidence, reviewRequired],
  );

  const response = {
    message: "The vehicle has successfully entered the parking area.",

    session: result.rows[0],
  };

  await saveProcessingResult({
    imageKey,
    operation: "entry",
    plateNumber,
    processingStatus: "SUCCESS",
    message: response.message,
    httpStatus: 200,
  });

  console.log("Parking entry session created:", JSON.stringify(result.rows[0]));

  return response;
}

async function completeExitSession(event) {
  const plateNumber = validatePlateNumber(event.plateNumber);

  const imageKey = validateImageKey(event.imageKey);

  const confidence = parseConfidence(event.confidence);

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const activeSessionResult = await client.query(
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
        "No active parking session was found for this vehicle.",
      );
    }

    const activeSession = activeSessionResult.rows[0];

    const entryTimestamp = new Date(activeSession.entry_timestamp);

    const exitTimestamp = new Date();

    const durationMilliseconds =
      exitTimestamp.getTime() - entryTimestamp.getTime();

    const durationMinutes = Math.max(
      1,
      Math.ceil(durationMilliseconds / 60000),
    );

    const sessionHourlyRate = Number(activeSession.hourly_rate ?? HOURLY_RATE);

    const calculatedFee = Number(
      ((durationMinutes / 60) * sessionHourlyRate).toFixed(2),
    );

    const reviewRequired =
      Boolean(activeSession.review_required) ||
      requiresManualReview(confidence);

    const receiptNumber = createReceiptNumber(
      activeSession.session_id,
      exitTimestamp,
    );

    const completedSessionResult = await client.query(
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

    const response = {
      message: "The vehicle has successfully exited the parking area.",

      session: completedSessionResult.rows[0],

      receipt: {
        receiptNumber,
        currency: "ZAR",
        hourlyRate: sessionHourlyRate,
        durationMinutes,
        totalFee: calculatedFee,
      },
    };

    await saveProcessingResult({
      imageKey,
      operation: "exit",
      plateNumber,
      processingStatus: "SUCCESS",
      message:
        "The vehicle has successfully exited the parking area. The parking receipt is now available.",
      httpStatus: 200,
    });

    return response;
  } catch (error) {
    await client.query("ROLLBACK");

    throw error;
  } finally {
    client.release();
  }
}

async function listParkingSessions(event) {
  const requestedLimit = Number(event.limit ?? 50);

  const limit = Number.isInteger(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), 100)
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

async function getProcessingStatus(event) {
  const imageKey = event.imageKey ?? event.queryStringParameters?.imageKey;

  if (!imageKey) {
    throw new ApplicationError(400, "The image key is required.");
  }

  const result = await pool.query(
    `
      SELECT
        result_id,
        image_key,
        operation,
        plate_number,
        processing_status,
        result_message,
        http_status,
        created_at,
        updated_at

      FROM processing_results

      WHERE image_key = $1

      LIMIT 1;
    `,
    [imageKey],
  );

  if (result.rowCount === 0) {
    return {
      processingStatus: "PENDING",
      message: "The licence plate image is still being processed.",
    };
  }

  const row = result.rows[0];

  return {
    processingStatus: row.processing_status,

    message: row.result_message,

    httpStatus: row.http_status,

    operation: row.operation,

    plateNumber: row.plate_number,

    imageKey: row.image_key,

    updatedAt: row.updated_at,
  };
}

function isGetSessionsRequest(event) {
  const httpMethod = event.requestContext?.http?.method;

  const rawPath = event.rawPath;

  const routeKey = event.routeKey;

  return (
    routeKey === "GET /sessions" ||
    (httpMethod === "GET" && rawPath === "/sessions")
  );
}

function isGetProcessingStatusRequest(event) {
  const httpMethod = event.requestContext?.http?.method;

  const rawPath = event.rawPath;

  const routeKey = event.routeKey;

  return (
    routeKey === "GET /processing-status" ||
    (httpMethod === "GET" && rawPath === "/processing-status")
  );
}

export const handler = async (event = {}, context) => {
  if (context) {
    context.callbackWaitsForEmptyEventLoop = false;
  }

  console.log("Database Lambda event:", JSON.stringify(event));

  const apiGatewaySessionsRequest = isGetSessionsRequest(event);

  const apiGatewayStatusRequest = isGetProcessingStatusRequest(event);

  const action = apiGatewaySessionsRequest
    ? "list"
    : apiGatewayStatusRequest
      ? "processingStatus"
      : (event.action ?? "health");

  const request = apiGatewaySessionsRequest
    ? {
        ...event,

        limit: event.queryStringParameters?.limit ?? 50,
      }
    : event;

  console.log("Database action received:", action);

  try {
    let result;

    switch (action) {
      case "init":
        result = await initialiseDatabase();
        break;

      case "health":
        result = await runHealthCheck();
        break;

      case "entry":
        result = await createEntrySession(request);
        break;

      case "exit":
        result = await completeExitSession(request);
        break;

      case "list":
        result = await listParkingSessions(request);
        break;

      case "processingStatus":
        result = await getProcessingStatus(request);
        break;

      case "claimProcessing":
        result = await claimProcessing(request);
        break;

      case "recordProcessingResult":
        result = await recordProcessingResult(request);
        break;

      default:
        throw new ApplicationError(400, "Unsupported database action.");
    }

    return createResponse(200, result);
  } catch (error) {
    console.error("Database operation failed:", {
      name: error.name,
      message: error.message,
      code: error.code,
      detail: error.detail,
      constraint: error.constraint,
      stack: error.stack,
    });

    let statusCode;
    let userMessage;
    let processingStatus;

    if (error.code === "23505") {
      statusCode = 409;

      userMessage =
        "This vehicle is already in the parking area. Please check the vehicle out before attempting another entry.";

      processingStatus = "REJECTED";
    } else if (error instanceof ApplicationError) {
      statusCode = error.statusCode;

      userMessage = error.message;

      processingStatus = "REJECTED";
    } else {
      statusCode = 500;

      userMessage =
        "The parking operation could not be completed. Please try again.";

      processingStatus = "FAILED";
    }

    try {
      await saveProcessingResult({
        imageKey: request.imageKey,

        operation:
          request.action === "exit"
            ? "exit"
            : request.action === "entry"
              ? "entry"
              : "unknown",

        plateNumber: request.plateNumber
          ? normalisePlateNumber(request.plateNumber)
          : null,

        processingStatus,
        message: userMessage,
        httpStatus: statusCode,
      });
    } catch (loggingError) {
      console.error("Failed to store processing result:", loggingError);
    }

    return createResponse(statusCode, {
      processingStatus,
      message: userMessage,

      error: statusCode === 500 ? error.message : undefined,
    });
  }
};
