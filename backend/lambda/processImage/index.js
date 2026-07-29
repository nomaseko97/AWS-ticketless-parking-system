import {
  DetectTextCommand,
  RekognitionClient,
} from "@aws-sdk/client-rekognition";

const rekognitionClient = new RekognitionClient({
  region: process.env.AWS_REGION || "eu-west-1",
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

function sortLeftToRight(detections) {
  return [...detections].sort((first, second) => {
    const firstLeft = getBox(first)?.left ?? 0;
    const secondLeft = getBox(second)?.left ?? 0;

    return firstLeft - secondLeft;
  });
}

function mergeWithOverlap(leftText, rightText) {
  const left = normalisePlateText(leftText);
  const right = normalisePlateText(rightText);

  if (!left) {
    return right;
  }

  if (!right) {
    return left;
  }

  if (left.includes(right)) {
    return left;
  }

  if (right.includes(left)) {
    return right;
  }

  const maximumOverlap = Math.min(left.length, right.length);

  for (
    let overlapLength = maximumOverlap;
    overlapLength > 0;
    overlapLength -= 1
  ) {
    const leftEnding = left.slice(-overlapLength);
    const rightBeginning = right.slice(0, overlapLength);

    if (leftEnding === rightBeginning) {
      return left + right.slice(overlapLength);
    }
  }

  return left + right;
}

function createCandidate(detections, merged) {
  const sortedDetections = sortLeftToRight(detections);

  const normalisedText = sortedDetections.reduce((currentText, detection) => {
    return mergeWithOverlap(currentText, detection.DetectedText);
  }, "");

  const containsLetter = /[A-Z]/.test(normalisedText);

  const containsNumber = /[0-9]/.test(normalisedText);

  if (!containsNumber) {
    return null;
  }

  if (normalisedText.length < 4 || normalisedText.length > 10) {
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

  if (normalisedText.length >= 5 && normalisedText.length <= 8) {
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

  // Add every complete detected line as a candidate.
  for (const detection of lineDetections) {
    const candidate = createCandidate([detection], false);

    if (candidate) {
      candidates.push(candidate);
    }
  }

  /*
   * Combine two text sections when Rekognition split
   * one licence plate into separate lines.
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

  const uniqueCandidates = new Map();

  for (const candidate of candidates) {
    const existingCandidate = uniqueCandidates.get(candidate.normalisedText);

    if (!existingCandidate || candidate.score > existingCandidate.score) {
      uniqueCandidates.set(candidate.normalisedText, candidate);
    }
  }

  const sortedCandidates = [...uniqueCandidates.values()].sort(
    (first, second) => second.score - first.score,
  );

  console.log(
    "Top licence plate candidates:",
    JSON.stringify(sortedCandidates.slice(0, 5), null, 2),
  );

  return sortedCandidates[0] ?? null;
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

  const result = {
    bucketName,
    objectKey,
    operation,
    detectedLines,
    plateCandidate,
  };

  console.log(
    "Rekognition processing result:",
    JSON.stringify(result, null, 2),
  );

  return result;
}

export const handler = async (event) => {
  try {
    if (!Array.isArray(event?.Records) || event.Records.length === 0) {
      throw new Error("No S3 records were found in the event.");
    }

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
