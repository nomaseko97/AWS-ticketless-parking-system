import { randomUUID } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3Client = new S3Client({
  region: process.env.AWS_REGION || "eu-west-1",
});

const allowedImageTypes = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function createResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

export async function handler(event) {
  try {
    if (!process.env.BUCKET_NAME) {
      throw new Error("BUCKET_NAME environment variable is not configured.");
    }

    const requestBody =
      typeof event.body === "string" ? JSON.parse(event.body) : event.body;

    const { operation, contentType } = requestBody || {};

    if (!["entry", "exit"].includes(operation)) {
      return createResponse(400, {
        message: "Operation must be entry or exit.",
      });
    }

    const fileExtension = allowedImageTypes[contentType];

    if (!fileExtension) {
      return createResponse(400, {
        message: "Only JPG, PNG and WebP images are allowed.",
      });
    }

    const currentDate = new Date();
    const year = currentDate.getUTCFullYear();
    const month = String(currentDate.getUTCMonth() + 1).padStart(2, "0");
    const day = String(currentDate.getUTCDate()).padStart(2, "0");

    const objectKey =
      `uploads/${operation}/${year}/${month}/${day}/` +
      `${randomUUID()}.${fileExtension}`;

    const uploadCommand = new PutObjectCommand({
      Bucket: process.env.BUCKET_NAME,
      Key: objectKey,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(s3Client, uploadCommand, {
      expiresIn: 300,
    });

    return createResponse(200, {
      uploadUrl,
      objectKey,
      operation,
      expiresIn: 300,
    });
  } catch (error) {
    console.error("Failed to create upload URL:", error);

    return createResponse(500, {
      message: "Unable to create the upload URL.",
    });
  }
}
