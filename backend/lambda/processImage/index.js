import {
  DetectTextCommand,
  RekognitionClient,
} from "@aws-sdk/client-rekognition";

import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";

const REGION = process.env.AWS_REGION || "eu-west-1";

const DATABASE_HANDLER_FUNCTION_NAME =
  process.env.DATABASE_HANDLER_FUNCTION_NAME;

if (!DATABASE_HANDLER_FUNCTION_NAME) {
  throw new Error("DATABASE_HANDLER_FUNCTION_NAME is not configured.");
}

const rekognitionClient = new RekognitionClient({
  region: REGION,
});

const lambdaClient = new LambdaClient({
  region: REGION,
});

function decodeS3Key(encodedKey) {
  return decodeURIComponent(encodedKey.replace(/\+/g, " "));
}

function getOperation(objectKey) {
  if (objectKey.startsWith("uploads/entry/")) {
    return "entry";
  }

  if (objectKey.startsWith("uploads/exit/")) {
    return "exit";
  }

  return "unknown";
}

function normalisePlateText(text = "") {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function getBox(detection) {
  const box = detection?.Geometry?.BoundingBox;

  if (!box) {
    return null;
  }

  const left = box.Left ?? 0;
  const top = box.Top ?? 0;
  const width = box.Width ?? 0;
  const height = box.Height ?? 0;

  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    centreY: top + height / 2,
  };
}

function areOnSameRow(firstDetection, secondDetection) {
  const firstBox = getBox(firstDetection);
  const secondBox = getBox(secondDetection);

  if (!firstBox || !secondBox) {
    return false;
  }

  const overlapTop = Math.max(firstBox.top, secondBox.top);

  const overlapBottom = Math.min(firstBox.bottom, secondBox.bottom);

  const verticalOverlap = Math.max(0, overlapBottom - overlapTop);

  const smallerHeight = Math.min(firstBox.height, secondBox.height);

  const overlapRatio = smallerHeight > 0 ? verticalOverlap / smallerHeight : 0;

  const centreDifference = Math.abs(firstBox.centreY - secondBox.centreY);

  const centreTolerance = Math.max(0.08, smallerHeight * 1.5);

  return overlapRatio >= 0.1 || centreDifference <= centreTolerance;
}

function horizontalGap(firstDetection, secondDetection) {
  const firstBox = getBox(firstDetection);
  const secondBox = getBox(secondDetection);

  if (!firstBox || !secondBox) {
    return Number.POSITIVE_INFINITY;
  }

  const leftBox = firstBox.left <= secondBox.left ? firstBox : secondBox;

  const rightBox = firstBox.left <= secondBox.left ? secondBox : firstBox;

  return Math.max(0, rightBox.left - leftBox.right);
}

function horizontalOverlapRatio(firstDetection, secondDetection) {
  const firstBox = getBox(firstDetection);
  const secondBox = getBox(secondDetection);

  if (!firstBox || !secondBox) {
    return 0;
  }

  const overlapLeft = Math.max(firstBox.left, secondBox.left);

  const overlapRight = Math.min(firstBox.right, secondBox.right);

  const overlapWidth = Math.max(0, overlapRight - overlapLeft);

  const smallerWidth = Math.min(firstBox.width, secondBox.width);

  if (smallerWidth <= 0) {
    return 0;
  }

  return overlapWidth / smallerWidth;
}

function sortLeftToRight(detections) {
  return [...detections].sort((firstDetection, secondDetection) => {
    const firstLeft = getBox(firstDetection)?.left ?? 0;

    const secondLeft = getBox(secondDetection)?.left ?? 0;

    return firstLeft - secondLeft;
  });
}

function calculateAverageCharacterWidth(detection) {
  const box = getBox(detection);

  const text = normalisePlateText(detection?.DetectedText);

  if (!box || text.length === 0) {
    return 0;
  }

  return box.width / text.length;
}

function shouldRemoveTextOverlap(
  previousDetection,
  currentDetection,
  overlapLength,
) {
  /*
   * If the Rekognition boxes overlap physically, the
   * repeated boundary character probably represents the
   * same character detected twice.
   *
   * Example:
   * 9JR + RI205 becomes 9JRI205.
   */
  const physicalOverlap = horizontalOverlapRatio(
    previousDetection,
    currentDetection,
  );

  if (physicalOverlap >= 0.02) {
    return true;
  }

  /*
   * If the boxes do not overlap, only remove the repeated
   * character when the two text boxes are extremely close.
   *
   * This preserves both G characters in:
   * JC12CG + GP = JC12CGGP
   *
   * The Gauteng emblem creates a larger physical gap between
   * the first G and the second G.
   */
  const gap = horizontalGap(previousDetection, currentDetection);

  const previousCharacterWidth =
    calculateAverageCharacterWidth(previousDetection);

  const currentCharacterWidth =
    calculateAverageCharacterWidth(currentDetection);

  const availableCharacterWidths = [
    previousCharacterWidth,
    currentCharacterWidth,
  ].filter((width) => width > 0);

  if (availableCharacterWidths.length === 0) {
    return false;
  }

  const smallerCharacterWidth = Math.min(...availableCharacterWidths);

  const allowedGap = Math.max(
    0.003,
    smallerCharacterWidth * 0.4 * overlapLength,
  );

  return gap <= allowedGap;
}

function mergeDetectedSegments(
  currentText,
  previousDetection,
  currentDetection,
) {
  const leftText = normalisePlateText(currentText);

  const rightText = normalisePlateText(currentDetection?.DetectedText);

  if (!leftText) {
    return rightText;
  }

  if (!rightText) {
    return leftText;
  }

  const maximumOverlap = Math.min(leftText.length, rightText.length);

  for (
    let overlapLength = maximumOverlap;
    overlapLength > 0;
    overlapLength -= 1
  ) {
    const leftEnding = leftText.slice(-overlapLength);

    const rightBeginning = rightText.slice(0, overlapLength);

    if (leftEnding !== rightBeginning) {
      continue;
    }

    if (
      shouldRemoveTextOverlap(
        previousDetection,
        currentDetection,
        overlapLength,
      )
    ) {
      return leftText + rightText.slice(overlapLength);
    }
  }

  return leftText + rightText;
}

function createCandidate(detections, merged) {
  const sortedDetections = sortLeftToRight(detections);

  const normalisedText = sortedDetections.reduce(
    (currentText, detection, index) => {
      if (index === 0) {
        return normalisePlateText(detection.DetectedText);
      }

      return mergeDetectedSegments(
        currentText,
        sortedDetections[index - 1],
        detection,
      );
    },
    "",
  );

  const containsLetter = /[A-Z]/.test(normalisedText);

  const containsNumber = /[0-9]/.test(normalisedText);

  if (!containsNumber) {
    return null;
  }

  if (normalisedText.length < 4 || normalisedText.length > 12) {
    return null;
  }

  const totalConfidence = sortedDetections.reduce((total, detection) => {
    return total + (detection.Confidence ?? 0);
  }, 0);

  const confidence = totalConfidence / sortedDetections.length;

  let score = confidence;

  if (containsLetter && containsNumber) {
    score += 45;
  }

  if (normalisedText.length >= 5 && normalisedText.length <= 9) {
    score += 45;
  } else {
    score += 20;
  }

  if (merged) {
    score += 60;
  }

  const boxes = sortedDetections.map(getBox).filter(Boolean);

  if (boxes.length > 0) {
    const left = Math.min(...boxes.map((box) => box.left));

    const right = Math.max(...boxes.map((box) => box.right));

    const top = Math.min(...boxes.map((box) => box.top));

    const bottom = Math.max(...boxes.map((box) => box.bottom));

    const combinedWidth = right - left;

    const combinedHeight = bottom - top;

    score += Math.min(combinedWidth * 70, 40);

    score += Math.min(combinedHeight * 250, 45);
  }

  return {
    originalText: sortedDetections
      .map((detection) => detection.DetectedText)
      .join(" + "),

    normalisedText,

    confidence: Number(confidence.toFixed(2)),

    score: Number(score.toFixed(2)),

    merged,

    detectionCount: sortedDetections.length,
  };
}

function selectPlateCandidate(textDetections = []) {
  const lineDetections = textDetections.filter((detection) => {
    return (
      detection.Type === "LINE" &&
      Boolean(normalisePlateText(detection.DetectedText)) &&
      (detection.Confidence ?? 0) >= 20 &&
      Boolean(getBox(detection))
    );
  });

  const candidates = [];

  /*
   * First, create candidates from each individual
   * Rekognition LINE detection.
   */
  for (const detection of lineDetections) {
    const candidate = createCandidate([detection], false);

    if (candidate) {
      candidates.push(candidate);
    }
  }

  /*
   * Next, combine LINE detections that appear next to
   * each other on the same row.
   */
  for (
    let firstIndex = 0;
    firstIndex < lineDetections.length;
    firstIndex += 1
  ) {
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < lineDetections.length;
      secondIndex += 1
    ) {
      const firstDetection = lineDetections[firstIndex];

      const secondDetection = lineDetections[secondIndex];

      if (!areOnSameRow(firstDetection, secondDetection)) {
        continue;
      }

      if (horizontalGap(firstDetection, secondDetection) > 0.45) {
        continue;
      }

      const candidate = createCandidate(
        [firstDetection, secondDetection],
        true,
      );

      if (candidate) {
        candidates.push(candidate);
      }
    }
  }

  /*
   * Remove duplicate candidate values, keeping the
   * highest-scoring version.
   */
  const uniqueCandidates = new Map();

  for (const candidate of candidates) {
    const existingCandidate = uniqueCandidates.get(candidate.normalisedText);

    if (!existingCandidate || candidate.score > existingCandidate.score) {
      uniqueCandidates.set(candidate.normalisedText, candidate);
    }
  }

  const sortedCandidates = [...uniqueCandidates.values()].sort(
    (firstCandidate, secondCandidate) =>
      secondCandidate.score - firstCandidate.score,
  );

  console.log(
    "Top licence plate candidates:",
    JSON.stringify(sortedCandidates.slice(0, 5), null, 2),
  );

  return sortedCandidates[0] ?? null;
}

function decodeLambdaPayload(payload) {
  if (!payload) {
    throw new Error("The database Lambda returned no payload.");
  }

  const decodedPayload = Buffer.from(payload).toString("utf-8");

  try {
    return JSON.parse(decodedPayload);
  } catch {
    throw new Error(
      `The database Lambda returned invalid JSON: ${decodedPayload}`,
    );
  }
}

function decodeResponseBody(body) {
  if (!body) {
    return {};
  }

  if (typeof body === "object") {
    return body;
  }

  try {
    return JSON.parse(body);
  } catch {
    return {
      message: body,
    };
  }
}

async function invokeDatabaseHandler({
  operation,
  plateNumber,
  imageKey,
  confidence,
}) {
  const databaseRequest = {
    action: operation,
    plateNumber,
    imageKey,
    confidence,
  };

  console.log("Sending request to database Lambda:", databaseRequest);

  const command = new InvokeCommand({
    FunctionName: DATABASE_HANDLER_FUNCTION_NAME,

    InvocationType: "RequestResponse",

    Payload: Buffer.from(JSON.stringify(databaseRequest)),
  });

  const invokeResponse = await lambdaClient.send(command);

  if (invokeResponse.FunctionError) {
    const errorPayload = invokeResponse.Payload
      ? Buffer.from(invokeResponse.Payload).toString("utf-8")
      : "No error details returned.";

    throw new Error(`Database Lambda invocation failed: ${errorPayload}`);
  }

  const lambdaResponse = decodeLambdaPayload(invokeResponse.Payload);

  const statusCode = Number(lambdaResponse.statusCode ?? 500);

  const responseBody = decodeResponseBody(lambdaResponse.body);

  const result = {
    statusCode,
    ...responseBody,
  };

  if (statusCode >= 500) {
    throw new Error(
      responseBody.error ||
        responseBody.message ||
        "The database operation failed.",
    );
  }

  if (statusCode >= 400) {
    console.warn("Database request was rejected:", result);

    return {
      saved: false,
      ...result,
    };
  }

  console.log("Database operation successful:", result);

  return {
    saved: true,
    ...result,
  };
}

async function processS3Record(record) {
  const bucketName = record?.s3?.bucket?.name;

  const encodedObjectKey = record?.s3?.object?.key;

  if (!bucketName || !encodedObjectKey) {
    throw new Error("The S3 event is missing the bucket name or object key.");
  }

  const objectKey = decodeS3Key(encodedObjectKey);

  const operation = getOperation(objectKey);

  console.log("Processing uploaded image:", {
    bucketName,
    objectKey,
    operation,
  });

  if (operation === "unknown") {
    return {
      objectKey,
      operation,
      skipped: true,
      reason: "Unsupported S3 object path.",
    };
  }

  const detectTextCommand = new DetectTextCommand({
    Image: {
      S3Object: {
        Bucket: bucketName,
        Name: objectKey,
      },
    },
  });

  const rekognitionResponse = await rekognitionClient.send(detectTextCommand);

  const textDetections = rekognitionResponse.TextDetections ?? [];

  const detectedLines = textDetections
    .filter((detection) => detection.Type === "LINE")
    .map((detection) => ({
      text: detection.DetectedText ?? "",

      confidence: Number((detection.Confidence ?? 0).toFixed(2)),
    }));

  const plateCandidate = selectPlateCandidate(textDetections);

  let databaseResult = {
    saved: false,
    reason: "No licence plate candidate was found.",
  };

  if (plateCandidate) {
    databaseResult = await invokeDatabaseHandler({
      operation,

      plateNumber: plateCandidate.normalisedText,

      imageKey: objectKey,

      confidence: plateCandidate.confidence,
    });
  } else {
    console.warn(
      "No licence plate candidate was found. The image was not saved as a parking session.",
    );
  }

  const result = {
    bucketName,
    objectKey,
    operation,
    detectedLines,
    plateCandidate,
    databaseResult,
  };

  console.log("Complete processing result:", JSON.stringify(result, null, 2));

  return result;
}

export const handler = async (event) => {
  try {
    if (!Array.isArray(event?.Records) || event.Records.length === 0) {
      throw new Error("No S3 records were found in the event.");
    }

    console.log("Received S3 event:", JSON.stringify(event));

    const results = [];

    for (const record of event.Records) {
      const result = await processS3Record(record);

      results.push(result);
    }

    return {
      statusCode: 200,

      body: JSON.stringify({
        message: "Image processing completed.",

        results,
      }),
    };
  } catch (error) {
    console.error("Image processing failed:", error);

    throw error;
  }
};
