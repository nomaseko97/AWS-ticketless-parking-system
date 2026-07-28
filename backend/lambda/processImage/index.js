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

function normalisePlateText(text) {
  return text
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function selectPlateCandidate(textDetections = []) {
  const candidates = textDetections
    .filter((item) => {
      return (
        item.Type === "LINE" &&
        item.DetectedText &&
        item.Confidence >= 60
      );
    })
    .map((item) => {
      const normalisedText = normalisePlateText(item.DetectedText);
      const containsLetter = /[A-Z]/.test(normalisedText);
      const containsNumber = /[0-9]/.test(normalisedText);

      let score = item.Confidence;

      if (
        normalisedText.length >= 5 &&
        normalisedText.length <= 10
      ) {
        score += 10;
      }

      if (containsLetter && containsNumber) {
        score += 10;
      }

      return {
        originalText: item.DetectedText,
        normalisedText,
        confidence: Number(item.Confidence.toFixed(2)),
        score,
      };
    })
    .filter((item) => {
      return (
        item.normalisedText.length >= 4 &&
        item.normalisedText.length <= 12
      );
    })
    .sort((first, second) => second.score - first.score);

  return candidates[0] || null;
}

async function processS3Record(record) {
  const bucketName = record.s3.bucket.name;
  const objectKey = decodeS3Key(record.s3.object.key);
  const operation = getOperation(objectKey);

  console.log("Processing uploaded image:", {
    bucketName,
    objectKey,
    operation,
  });

  if (operation === "unknown") {
    console.log("Skipping object outside entry and exit folders.");

    return {
      objectKey,
      operation,
      skipped: true,
      reason: "Unsupported S3 object path.",
    };
  }

  const command = new DetectTextCommand({
    Image: {
      S3Object: {
        Bucket: bucketName,
        Name: objectKey,
      },
    },
  });

  const response = await rekognitionClient.send(command);
  const textDetections = response.TextDetections || [];

  const detectedLines = textDetections
    .filter((item) => item.Type === "LINE")
    .map((item) => ({
      text: item.DetectedText,
      confidence: Number((item.Confidence || 0).toFixed(2)),
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

export async function handler(event) {
  try {
    if (!Array.isArray(event.Records) || event.Records.length === 0) {
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
}