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

const OCR_NOISE_WORDS = new Set([
  "ZA",
  "RSA",
  "SANS",
  "GAUTENG",
  "REPUBLIC",
  "SOUTHAFRICA",
  "AFRICA",
  "DIPLOMATIC",
  "MOTOR",
]);

const OCR_NOISE_PARTS = ["SANS", "GAUTENG", "SOUTHAFRICA", "REPUBLIC"];

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
    centreX: left + width / 2,
    centreY: top + height / 2,
  };
}

function isKnownNoise(text = "") {
  const normalisedText = normalisePlateText(text);

  if (!normalisedText) {
    return true;
  }

  if (OCR_NOISE_WORDS.has(normalisedText)) {
    return true;
  }

  return OCR_NOISE_PARTS.some((noisePart) =>
    normalisedText.includes(noisePart),
  );
}

function isUsefulDetection(detection, maximumHeight) {
  const text = normalisePlateText(detection?.DetectedText);
  const box = getBox(detection);
  const confidence = detection?.Confidence ?? 0;

  if (!text || !box || confidence < 25) {
    return false;
  }

  if (isKnownNoise(text)) {
    return false;
  }

  /*
   * Tiny text near the lower edge is normally the SANS/manufacturer
   * marking printed beneath the registration number.
   */
  if (
    maximumHeight > 0 &&
    box.height < maximumHeight * 0.34 &&
    box.centreY > 0.58
  ) {
    return false;
  }

  if (box.height < 0.018 || box.width < 0.018) {
    return false;
  }

  return true;
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
  const centreTolerance = Math.max(
    0.045,
    Math.max(firstBox.height, secondBox.height) * 0.62,
  );

  return overlapRatio >= 0.25 || centreDifference <= centreTolerance;
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

  return smallerWidth > 0 ? overlapWidth / smallerWidth : 0;
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
  const physicalOverlap = horizontalOverlapRatio(
    previousDetection,
    currentDetection,
  );

  if (physicalOverlap >= 0.02) {
    return true;
  }

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
    smallerCharacterWidth * 0.5 * overlapLength,
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

function countCharacterTransitions(text) {
  let transitions = 0;

  for (let index = 1; index < text.length; index += 1) {
    const previousIsLetter = /[A-Z]/.test(text[index - 1]);
    const currentIsLetter = /[A-Z]/.test(text[index]);

    if (previousIsLetter !== currentIsLetter) {
      transitions += 1;
    }
  }

  return transitions;
}

function calculateCandidateBounds(detections) {
  const boxes = detections.map(getBox).filter(Boolean);

  if (boxes.length === 0) {
    return null;
  }

  const left = Math.min(...boxes.map((box) => box.left));
  const right = Math.max(...boxes.map((box) => box.right));
  const top = Math.min(...boxes.map((box) => box.top));
  const bottom = Math.max(...boxes.map((box) => box.bottom));

  return {
    left,
    right,
    top,
    bottom,
    width: right - left,
    height: bottom - top,
    centreX: (left + right) / 2,
    centreY: (top + bottom) / 2,
  };
}

function createCandidate(detections, merged, sourceType) {
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

  if (
    !normalisedText ||
    isKnownNoise(normalisedText) ||
    OCR_NOISE_PARTS.some((part) => normalisedText.includes(part))
  ) {
    return null;
  }

  const containsLetter = /[A-Z]/.test(normalisedText);
  const containsNumber = /[0-9]/.test(normalisedText);

  if (!containsLetter || !containsNumber) {
    return null;
  }

  if (normalisedText.length < 5 || normalisedText.length > 10) {
    return null;
  }

  const totalConfidence = sortedDetections.reduce(
    (total, detection) => total + (detection.Confidence ?? 0),
    0,
  );

  const confidence = totalConfidence / sortedDetections.length;
  const bounds = calculateCandidateBounds(sortedDetections);
  const transitions = countCharacterTransitions(normalisedText);

  let score = confidence;

  if (normalisedText.length >= 6 && normalisedText.length <= 9) {
    score += 58;
  } else {
    score += 24;
  }

  if (transitions >= 1 && transitions <= 3) {
    score += 30;
  } else if (transitions > 4) {
    score -= 25;
  }

  if (/^[A-Z]{1,4}[0-9]{1,4}[A-Z]{0,3}$/.test(normalisedText)) {
    score += 55;
  }

  /*
   * Reward a complete South African-style plate that includes a trailing
   * province/suffix letter. This helps BPG355B outrank the incomplete
   * BPG355 candidate when both are detected.
   */
  if (/^[A-Z]{2,4}[0-9]{2,4}[A-Z]{1,3}$/.test(normalisedText)) {
    score += 28;
  }

  if (/^[0-9]{1,4}[A-Z]{1,4}[0-9A-Z]{0,3}$/.test(normalisedText)) {
    score += 18;
  }

  if (merged) {
    score += 38;
  }

  if (sourceType === "LINE") {
    score += 12;
  }

  if (bounds) {
    score += Math.min(bounds.width * 95, 70);
    score += Math.min(bounds.height * 260, 55);

    if (bounds.centreX >= 0.2 && bounds.centreX <= 0.8) {
      score += 12;
    }

    if (bounds.centreY >= 0.18 && bounds.centreY <= 0.78) {
      score += 10;
    }

    if (bounds.centreY > 0.82) {
      score -= 45;
    }
  }

  if (/^[A-Z]{0,1}[0-9]{3,}/.test(normalisedText)) {
    score -= 18;
  }

  return {
    originalText: sortedDetections
      .map((detection) => detection.DetectedText)
      .join(" + "),
    normalisedText,
    confidence: Number(confidence.toFixed(2)),
    score: Number(score.toFixed(2)),
    merged,
    sourceType,
    detectionCount: sortedDetections.length,
    bounds,
  };
}

function detectionsCanBeJoined(firstDetection, secondDetection) {
  if (!areOnSameRow(firstDetection, secondDetection)) {
    return false;
  }

  const gap = horizontalGap(firstDetection, secondDetection);
  const firstCharacterWidth = calculateAverageCharacterWidth(firstDetection);
  const secondCharacterWidth = calculateAverageCharacterWidth(secondDetection);

  const usableCharacterWidths = [
    firstCharacterWidth,
    secondCharacterWidth,
  ].filter((width) => width > 0);

  const characterWidth =
    usableCharacterWidths.length > 0
      ? Math.max(...usableCharacterWidths)
      : 0.05;

  const firstText = normalisePlateText(firstDetection?.DetectedText);
  const secondText = normalisePlateText(secondDetection?.DetectedText);
  const firstBox = getBox(firstDetection);
  const secondBox = getBox(secondDetection);

  /*
   * Gauteng plates can place the provincial crest between the main number
   * and a final one- or two-letter suffix. For example, Rekognition may
   * return BPG355 and B as separate detections with a large physical gap.
   * Allow that suffix when both detections are large and aligned.
   */
  const secondLooksLikeProvinceSuffix = /^[A-Z]{1,2}$/.test(secondText);
  const firstLooksLikeMainPlate =
    /^[A-Z]{1,4}[0-9]{1,4}[A-Z]{0,2}$/.test(firstText) &&
    /[0-9]/.test(firstText);

  const similarHeight =
    firstBox &&
    secondBox &&
    Math.min(firstBox.height, secondBox.height) /
      Math.max(firstBox.height, secondBox.height) >=
      0.55;

  if (
    firstLooksLikeMainPlate &&
    secondLooksLikeProvinceSuffix &&
    similarHeight &&
    gap <= 0.34
  ) {
    return true;
  }

  /*
   * Normal allowance for neighbouring OCR segments. It is intentionally
   * wider than ordinary text because a crest may split a licence plate.
   */
  return gap <= Math.max(0.2, characterWidth * 6.5);
}

function buildRowGroups(detections) {
  const sortedByHeight = [...detections].sort((first, second) => {
    return (getBox(second)?.height ?? 0) - (getBox(first)?.height ?? 0);
  });

  const rows = [];

  for (const detection of sortedByHeight) {
    const matchingRow = rows.find((row) =>
      row.some((existingDetection) =>
        areOnSameRow(existingDetection, detection),
      ),
    );

    if (matchingRow) {
      matchingRow.push(detection);
    } else {
      rows.push([detection]);
    }
  }

  return rows.map(sortLeftToRight);
}

function addCandidatesFromDetectionPool(detections, sourceType, candidates) {
  if (detections.length === 0) {
    return;
  }

  const maximumHeight = Math.max(
    ...detections.map((detection) => getBox(detection)?.height ?? 0),
  );

  const usefulDetections = detections.filter((detection) =>
    isUsefulDetection(detection, maximumHeight),
  );

  for (const detection of usefulDetections) {
    const candidate = createCandidate([detection], false, sourceType);

    if (candidate) {
      candidates.push(candidate);
    }
  }

  const rows = buildRowGroups(usefulDetections);

  for (const row of rows) {
    /*
     * Build all contiguous combinations of up to four segments. This handles
     * Rekognition returning HDJ, 392 and GP as separate detections, while
     * avoiding unrelated text elsewhere in the image.
     */
    for (let startIndex = 0; startIndex < row.length; startIndex += 1) {
      const combination = [row[startIndex]];

      for (
        let nextIndex = startIndex + 1;
        nextIndex < row.length && combination.length < 4;
        nextIndex += 1
      ) {
        const previousDetection = combination[combination.length - 1];
        const nextDetection = row[nextIndex];

        if (!detectionsCanBeJoined(previousDetection, nextDetection)) {
          break;
        }

        combination.push(nextDetection);

        const candidate = createCandidate(combination, true, sourceType);

        if (candidate) {
          candidates.push(candidate);
        }
      }
    }
  }
}

function appendRightSideProvinceSuffix(candidate, detections) {
  if (!candidate?.bounds) {
    return candidate;
  }

  const currentText = candidate.normalisedText;

  if (!/^[A-Z]{1,4}[0-9]{2,4}[A-Z]{0,2}$/.test(currentText)) {
    return candidate;
  }

  const suffixDetections = detections
    .filter((detection) => {
      const text = normalisePlateText(detection?.DetectedText);
      const box = getBox(detection);

      if (!box || !/^[A-Z]{1,2}$/.test(text)) {
        return false;
      }

      if (isKnownNoise(text) || (detection.Confidence ?? 0) < 20) {
        return false;
      }

      const isToRight = box.left >= candidate.bounds.right - 0.015;
      const centreDifference = Math.abs(box.centreY - candidate.bounds.centreY);
      const rowTolerance = Math.max(
        0.08,
        Math.max(box.height, candidate.bounds.height) * 0.72,
      );
      const similarHeight =
        Math.min(box.height, candidate.bounds.height) /
          Math.max(box.height, candidate.bounds.height) >=
        0.38;
      const gap = Math.max(0, box.left - candidate.bounds.right);

      return (
        isToRight &&
        centreDifference <= rowTolerance &&
        similarHeight &&
        gap <= 0.42
      );
    })
    .sort((first, second) => {
      const firstBox = getBox(first);
      const secondBox = getBox(second);

      const firstGap = Math.max(0, firstBox.left - candidate.bounds.right);
      const secondGap = Math.max(0, secondBox.left - candidate.bounds.right);

      if (Math.abs(firstGap - secondGap) > 0.01) {
        return firstGap - secondGap;
      }

      return (second.Confidence ?? 0) - (first.Confidence ?? 0);
    });

  const suffixDetection = suffixDetections[0];

  if (!suffixDetection) {
    return candidate;
  }

  const suffix = normalisePlateText(suffixDetection.DetectedText);

  if (!suffix || currentText.endsWith(suffix)) {
    return candidate;
  }

  const combinedText = `${currentText}${suffix}`;

  if (combinedText.length > 10) {
    return candidate;
  }

  const suffixBox = getBox(suffixDetection);
  const combinedBounds = {
    left: Math.min(candidate.bounds.left, suffixBox.left),
    right: Math.max(candidate.bounds.right, suffixBox.right),
    top: Math.min(candidate.bounds.top, suffixBox.top),
    bottom: Math.max(candidate.bounds.bottom, suffixBox.bottom),
  };

  combinedBounds.width = combinedBounds.right - combinedBounds.left;
  combinedBounds.height = combinedBounds.bottom - combinedBounds.top;
  combinedBounds.centreX = (combinedBounds.left + combinedBounds.right) / 2;
  combinedBounds.centreY = (combinedBounds.top + combinedBounds.bottom) / 2;

  return {
    ...candidate,
    originalText: `${candidate.originalText} + ${suffixDetection.DetectedText}`,
    normalisedText: combinedText,
    confidence: Number(
      (
        (candidate.confidence * candidate.detectionCount +
          (suffixDetection.Confidence ?? 0)) /
        (candidate.detectionCount + 1)
      ).toFixed(2),
    ),
    score: Number((candidate.score + 72).toFixed(2)),
    merged: true,
    detectionCount: candidate.detectionCount + 1,
    bounds: combinedBounds,
    suffixRecovered: true,
  };
}

function selectPlateCandidate(textDetections = []) {
  const lineDetections = textDetections.filter(
    (detection) =>
      detection.Type === "LINE" &&
      Boolean(getBox(detection)) &&
      Boolean(normalisePlateText(detection.DetectedText)),
  );

  const wordDetections = textDetections.filter(
    (detection) =>
      detection.Type === "WORD" &&
      Boolean(getBox(detection)) &&
      Boolean(normalisePlateText(detection.DetectedText)),
  );

  const candidates = [];

  addCandidatesFromDetectionPool(lineDetections, "LINE", candidates);
  addCandidatesFromDetectionPool(wordDetections, "WORD", candidates);

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
    JSON.stringify(sortedCandidates.slice(0, 10), null, 2),
  );

  const initialBestCandidate = sortedCandidates[0] ?? null;

  const allUsefulDetections = [...lineDetections, ...wordDetections];
  const bestCandidate = appendRightSideProvinceSuffix(
    initialBestCandidate,
    allUsefulDetections,
  );

  if (bestCandidate?.suffixRecovered) {
    console.log(
      "Recovered right-side province suffix:",
      JSON.stringify(bestCandidate, null, 2),
    );
  }

  /*
   * Do not create a parking session from a very weak or incomplete result.
   * It is safer to ask for another image than to store the wrong vehicle.
   */
  if (!bestCandidate || bestCandidate.score < 145) {
    return null;
  }

  return bestCandidate;
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

async function invokeDatabaseAction(databaseRequest) {
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

  return result;
}

async function invokeParkingOperation({
  operation,
  plateNumber,
  imageKey,
  confidence,
}) {
  const result = await invokeDatabaseAction({
    action: operation,
    plateNumber,
    imageKey,
    confidence,
  });

  if (result.statusCode >= 400) {
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

async function claimImageProcessing({ objectKey, operation }) {
  return invokeDatabaseAction({
    action: "claimProcessing",
    imageKey: objectKey,
    operation,
  });
}

async function recordImageProcessingResult({
  objectKey,
  operation,
  plateNumber = null,
  processingStatus,
  message,
  httpStatus,
}) {
  return invokeDatabaseAction({
    action: "recordProcessingResult",
    imageKey: objectKey,
    operation,
    plateNumber,
    processingStatus,
    message,
    httpStatus,
  });
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

  /*
   * Atomically claim this exact image key before running Rekognition.
   * If S3 delivers the same event again, the second invocation sees the
   * existing row and exits without repeating the parking operation.
   */
  const claimResult = await claimImageProcessing({
    objectKey,
    operation,
  });

  if (!claimResult.shouldProcess) {
    console.log(
      "Duplicate S3 event ignored. Existing processing result:",
      JSON.stringify(claimResult.existingResult),
    );

    return {
      bucketName,
      objectKey,
      operation,
      duplicateEvent: true,
      skipped: true,
      existingResult: claimResult.existingResult,
    };
  }

  try {
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

    if (!plateCandidate) {
      const message =
        "The licence plate could not be read clearly. Please upload a clearer image.";

      await recordImageProcessingResult({
        objectKey,
        operation,
        processingStatus: "REJECTED",
        message,
        httpStatus: 422,
      });

      return {
        bucketName,
        objectKey,
        operation,
        detectedLines,
        plateCandidate: null,
        databaseResult: {
          saved: false,
          statusCode: 422,
          processingStatus: "REJECTED",
          message,
        },
      };
    }

    const databaseResult = await invokeParkingOperation({
      operation,
      plateNumber: plateCandidate.normalisedText,
      imageKey: objectKey,
      confidence: plateCandidate.confidence,
    });

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
  } catch (error) {
    console.error("S3 record processing failed:", {
      objectKey,
      operation,
      message: error.message,
      stack: error.stack,
    });

    /*
     * This cannot downgrade an existing SUCCESS result because the database
     * handler now preserves SUCCESS as the final state.
     */
    try {
      await recordImageProcessingResult({
        objectKey,
        operation,
        processingStatus: "FAILED",
        message:
          "The parking operation could not be completed. Please try again.",
        httpStatus: 500,
      });
    } catch (statusError) {
      console.error(
        "Failed to store the image processing failure:",
        statusError,
      );
    }

    throw error;
  }
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
