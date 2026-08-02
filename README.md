# 🚘 AWS Ticketless Parking System

> A cloud-based parking system that uses vehicle licence-plate recognition to manage vehicle entry and exit, calculate parking fees, and generate receipts without physical tickets.

<p align="center">
  <img src="https://img.shields.io/badge/AWS-Serverless-FF9900?logo=amazonaws&logoColor=white" alt="AWS Serverless">
  <img src="https://img.shields.io/badge/Frontend-React-61DAFB?logo=react&logoColor=black" alt="React">
  <img src="https://img.shields.io/badge/OCR-Amazon%20Rekognition-8C4FFF" alt="Amazon Rekognition">
  <img src="https://img.shields.io/badge/Database-PostgreSQL-4169E1?logo=postgresql&logoColor=white" alt="PostgreSQL">
  <img src="https://img.shields.io/badge/Status-Functional-success" alt="Project status">
</p>

---

# Project Overview

The **AWS Ticketless Parking System** replaces traditional paper parking tickets with vehicle licence-plate recognition.

A user uploads an image of a vehicle licence plate through a React web application. The image is stored in Amazon S3 and processed by AWS Lambda using Amazon Rekognition. The detected plate number is then used to create or complete a parking session in Amazon RDS PostgreSQL.

When the vehicle exits, the system calculates the parking duration, calculates the fee, updates the session, and generates a receipt.

This project demonstrates a complete cloud workflow from frontend upload to serverless processing and database persistence.

---

# Project Objectives

- Build a React frontend for vehicle image uploads.
- Store licence-plate images in Amazon S3.
- Generate secure presigned S3 upload URLs.
- Process uploaded images using AWS Lambda.
- Extract licence-plate text using Amazon Rekognition.
- Record vehicle entry and exit in PostgreSQL.
- Prevent duplicate active parking sessions.
- Prevent duplicate S3 event processing.
- Calculate parking duration and fees.
- Generate a receipt after a successful vehicle exit.
- Display parking activity in a dashboard.

---

# AWS Services Used

- Amazon S3
- AWS Lambda
- Amazon Rekognition
- Amazon API Gateway
- Amazon RDS for PostgreSQL
- Amazon CloudWatch
- AWS Identity and Access Management
- Amazon VPC
- Security Groups

---

# Architecture Diagram

<p align="center">
  <img src="./Project%20Screenshot/AWS-Ticketless-Parking-Architecture-AWS-Icons_0531.jpg"
       alt="AWS Ticketless Parking System Architecture"
       width="900">
</p>

Editable Draw.io file:

```text
docs/AWS-Ticketless-Parking-Architecture.drawio
```

---

# Architecture Decisions

- **React** provides the user interface for image uploads, parking actions, session history, and receipts.
- **Amazon API Gateway** exposes the backend endpoints used by the frontend.
- **createUploadUrl Lambda** creates a temporary presigned S3 upload URL.
- **Amazon S3** stores uploaded vehicle licence-plate images.
- **processImage Lambda** is triggered automatically when an image is uploaded.
- **Amazon Rekognition** extracts text from the uploaded image.
- **databaseHandler Lambda** applies parking rules and communicates with PostgreSQL.
- **Amazon RDS PostgreSQL** stores parking sessions and image-processing results.
- **Amazon CloudWatch** stores Lambda logs for debugging and monitoring.
- **AWS IAM** controls permissions between AWS services.
- **Presigned URLs** allow secure browser uploads without exposing AWS credentials.
- **Duplicate-processing protection** prevents repeated S3 events from creating duplicate records.

---

# How the System Works

## Vehicle Entry

1. The user selects **Vehicle Entry**.
2. The user uploads a clear licence-plate image.
3. The frontend requests a presigned upload URL.
4. The image is uploaded directly to Amazon S3.
5. Amazon S3 triggers the `processImage` Lambda.
6. Amazon Rekognition extracts text from the image.
7. The detected licence plate is cleaned and validated.
8. The database checks whether the vehicle already has an active session.
9. A new parking session is created with an `ACTIVE` status.
10. The session appears on the dashboard.

## Vehicle Exit

1. The user selects **Vehicle Exit**.
2. The user uploads the vehicle licence-plate image.
3. The image is processed using the same OCR workflow.
4. The database searches for a matching active session.
5. The exit time is recorded.
6. The parking duration is calculated.
7. The parking fee is calculated.
8. The session status changes to `COMPLETED`.
9. A receipt number is generated.
10. The receipt becomes available to the user.

---

# Core Features

- Vehicle entry registration
- Vehicle exit processing
- Licence-plate text recognition
- Active parking-session tracking
- Completed-session history
- Duplicate entry prevention
- Duplicate S3 event protection
- Parking-duration calculation
- Parking-fee calculation
- Receipt generation
- Processing-status tracking
- User-friendly validation messages
- Parking activity dashboard

---

# Technology Stack

| Area | Technology |
|---|---|
| Frontend | React, Vite, JavaScript, CSS |
| Backend | Node.js, AWS Lambda |
| API | Amazon API Gateway |
| Image Storage | Amazon S3 |
| OCR | Amazon Rekognition |
| Database | Amazon RDS PostgreSQL |
| Monitoring | Amazon CloudWatch |
| Security | AWS IAM, Security Groups |
| Version Control | Git and GitHub |

---

# Project Structure

```text
AWS-ticketless-parking-system/
├── backend/
│   ├── createUploadUrl/
│   │   └── index.js
│   ├── processImage/
│   │   └── index.js
│   └── databaseHandler/
│       └── index.js
├── frontend/
│   ├── src/
│   │   ├── App.jsx
│   │   ├── App.css
│   │   └── main.jsx
│   ├── package.json
│   └── vite.config.js
├── docs/
│   ├── AWS-Ticketless-Parking-Architecture.drawio
│   └── aws-ticketless-parking-architecture.png
├── Screenshots/
├── .gitignore
└── README.md
```

---

# API Endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/upload-url` | Generates a presigned S3 upload URL |
| `GET` | `/processing-status` | Checks the image-processing result |
| `GET` | `/sessions` | Retrieves parking-session records |

---

# Business Rules

- A vehicle can only have one active parking session.
- A vehicle cannot exit unless a matching active session exists.
- Duplicate S3 events must not create duplicate parking transactions.
- A completed session must contain an exit timestamp.
- Parking duration is calculated from the entry and exit timestamps.
- Parking fees are calculated using the configured hourly rate.
- A receipt is generated only after a successful vehicle exit.
- Unclear or unsupported OCR results are rejected or marked for review.
- AWS credentials and database secrets must never be exposed in the frontend.

---

# Screenshots of the Project

## Application Dashboard

<img src="./Project%20Screenshot/Dashboardpng.png" width="700">

## Vehicle Entry

<img src="./Project%20Screenshot/vehicleEntry.png" width="700">

## Vehicle Entered

<img src="./Project%20Screenshot/vehicle%20entered.png" width="700">
## Image Preview

<img src="./Project%20Screenshot/vehicleEntry.png" width="700">

## Active Parking Session

<img src="./Project%20Screenshot/parkingSessions.png" width="700">

## Duplicate Entry Prevention

<img src="./Project%20Screenshot/duplicateParking.png" width="700">

## Vehicle Exit

<img src="./Project%20Screenshot/vehicleExit.png" width="700">

## Vehicle Exited

<img src="./Project%20Screenshot/vehicleExited.png" width="700">

## Completed Parking Session

<img src="./Project%20Screenshot/completedSession.png" width="700">

## Generated Receipt

<img src="./Project%20Screenshot/receipt.png" width="700">

## Amazon S3 Image Upload

<img src="./Project%20Screenshot/ Amazon S3 Image Upload.png" width="700">

## AWS Lambda Functions

<img src=./Project%20Screenshot/10 AWS Lambda Functions.png" width="700">

## Amazon API Gateway Routes

<img src="./Project%20Screenshot/ API Gateway Routes.png" width="700">

## Amazon RDS Parking Session

<img src="./Project%20Screenshot/ RDS Parking Session.png" width="700">

## CloudWatch Processing Logs

<img src="./Project%20Screenshot/3 CloudWatch Processing Logs.png" width="700">



---

# Testing and Verification

The following scenarios were tested:

- Valid vehicle entry creates an active session.
- Duplicate vehicle entry is rejected.
- Valid vehicle exit completes the matching session.
- Vehicle exit without an active session is rejected.
- Unsupported file types are rejected.
- Images larger than the configured limit are rejected.
- Unclear licence plates are rejected or flagged.
- Duplicate S3 events do not create duplicate records.
- Parking duration and fee are calculated correctly.
- A receipt is generated after vehicle exit.
- Dashboard refresh displays the latest database records.
- CloudWatch logs confirm successful Lambda processing.
- PostgreSQL records confirm correct session creation and updates.

---

# Challenges Encountered

## OCR Accuracy

Amazon Rekognition did not always return the full licence plate as one clean value. Some results contained unrelated text or missed a final character.

This was improved by:

- reviewing both line and word detections;
- removing irrelevant detected text;
- combining likely plate segments;
- scoring possible licence-plate candidates;
- validating results before updating the database.

## Duplicate S3 Events

Amazon S3 may send the same event more than once.

Without protection, this could create duplicate entry or exit transactions.

The solution records and claims processing activity before applying the parking transaction.

## Asynchronous Processing

The frontend upload completes before OCR and database processing finish.

A processing-status endpoint was added so that the frontend can check the result and provide the correct message to the user.

## False Frontend Errors

The database operation could succeed while the frontend displayed an error because of a delayed status response.

The frontend response handling was updated to distinguish between:

- successful processing;
- genuine rejection;
- delayed confirmation.

---

# Security Considerations

- AWS credentials are not stored in the frontend.
- Images are uploaded using temporary presigned URLs.
- Amazon S3 public access should remain blocked.
- IAM permissions should follow the principle of least privilege.
- PostgreSQL access should be restricted through Security Groups.
- Database credentials should be stored securely.
- SQL queries should be parameterised.
- CloudWatch logs should not expose sensitive data.
- `.env` files must not be committed to GitHub.
- RDS should remain private where possible.

---

# Lessons Learned

- Designed an end-to-end AWS serverless workflow.
- Connected a React frontend to AWS API Gateway.
- Used Amazon S3 events to trigger Lambda processing.
- Used Amazon Rekognition for OCR.
- Worked with OCR results that are not always predictable.
- Implemented duplicate-event protection.
- Applied parking business rules in PostgreSQL.
- Debugged Lambda functions using CloudWatch.
- Improved frontend feedback for asynchronous processing.
- Learned the importance of security, monitoring, and documentation.

---

# Future Improvements

- Add manual correction for uncertain OCR results.
- Add user authentication.
- Add administrator and parking-operator roles.
- Add search and filtering by licence plate.
- Generate PDF receipts.
- Send receipts by email or SMS.
- Add automated frontend and backend tests.
- Add GitHub Actions CI/CD.
- Add CloudWatch alarms.
- Use Amazon SQS for more reliable event processing.
- Deploy infrastructure using Terraform or AWS CloudFormation.
- Create separate development and production environments.

---

# Conclusion

The AWS Ticketless Parking System demonstrates a complete cloud-native parking workflow using React, AWS Lambda, Amazon S3, Amazon Rekognition, Amazon API Gateway, and Amazon RDS PostgreSQL.

The project combines secure image upload, event-driven processing, OCR, database integration, parking-session management, fee calculation, receipt generation, monitoring, and error handling in one solution.

It shows practical understanding of how multiple AWS services can work together to solve a real-world problem.

---

# Author

**Nomaseko Brilliant Mahlangu**

GitHub: [@nomaseko97](https://github.com/nomaseko97)
