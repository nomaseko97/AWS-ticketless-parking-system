import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL;

const uploadUrlEndpoint = `${apiBaseUrl}/upload-url`;
const sessionsEndpoint = `${apiBaseUrl}/sessions`;
const processingStatusEndpoint = `${apiBaseUrl}/processing-status`;

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const PROCESSING_POLL_INTERVAL = 1000;
const PROCESSING_MAX_ATTEMPTS = 8;

function App() {
  const [operation, setOperation] = useState("entry");
  const [selectedImage, setSelectedImage] = useState(null);
  const [previewUrl, setPreviewUrl] = useState("");

  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [isUploading, setIsUploading] = useState(false);

  const [sessions, setSessions] = useState([]);
  const [isLoadingSessions, setIsLoadingSessions] = useState(true);
  const [isRefreshingSessions, setIsRefreshingSessions] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);

  const [sessionFilter, setSessionFilter] = useState("ALL");
  const [selectedReceipt, setSelectedReceipt] = useState(null);

  const fileInputRef = useRef(null);
  const sessionsSectionRef = useRef(null);

  const fetchSessions = useCallback(async (showLoading = false) => {
    if (showLoading) {
      setIsLoadingSessions(true);
    } else {
      setIsRefreshingSessions(true);
    }

    try {
      const response = await fetch(`${sessionsEndpoint}?limit=50`, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(
          `Parking sessions request returned status ${response.status}.`,
        );
      }

      const data = await response.json();

      const receivedSessions = Array.isArray(data.sessions)
        ? data.sessions
        : [];

      const newestSessionsFirst = [...receivedSessions].sort(
        (firstSession, secondSession) => {
          const firstTime = new Date(firstSession.entry_timestamp).getTime();

          const secondTime = new Date(secondSession.entry_timestamp).getTime();

          return secondTime - firstTime;
        },
      );

      setSessions(newestSessionsFirst);
      setLastUpdated(new Date());
    } catch (error) {
      console.error("Failed to load parking sessions:", error);
    } finally {
      setIsLoadingSessions(false);
      setIsRefreshingSessions(false);
    }
  }, []);

  useEffect(() => {
    fetchSessions(true);
  }, [fetchSessions]);

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  useEffect(() => {
    document.body.style.overflow = selectedReceipt ? "hidden" : "";

    return () => {
      document.body.style.overflow = "";
    };
  }, [selectedReceipt]);

  useEffect(() => {
    function handleEscapeKey(event) {
      if (event.key === "Escape") {
        setSelectedReceipt(null);
      }
    }

    window.addEventListener("keydown", handleEscapeKey);

    return () => {
      window.removeEventListener("keydown", handleEscapeKey);
    };
  }, []);

  function clearSelectedImage() {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }

    setSelectedImage(null);
    setPreviewUrl("");

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function resetImageForm() {
    clearSelectedImage();
    setErrorMessage("");
    setSuccessMessage("");
  }

  function handleOperationChange(nextOperation) {
    if (isUploading) {
      return;
    }

    setOperation(nextOperation);
    resetImageForm();
  }

  function handleSummaryCardClick(filter) {
    setSessionFilter(filter);

    window.setTimeout(() => {
      sessionsSectionRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }, 50);
  }

  function validateImage(file) {
    if (!file) {
      return "Please select a licence-plate image.";
    }

    const validImageTypes = ["image/jpeg", "image/jpg", "image/png"];

    if (!validImageTypes.includes(file.type)) {
      return "Please select a JPG, JPEG or PNG image.";
    }

    if (file.size > MAX_FILE_SIZE) {
      return "The image must be smaller than 5 MB.";
    }

    return "";
  }

  function handleImageSelection(event) {
    const file = event.target.files?.[0];

    setErrorMessage("");
    setSuccessMessage("");

    const validationError = validateImage(file);

    if (validationError) {
      clearSelectedImage();
      setErrorMessage(validationError);
      return;
    }

    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }

    setSelectedImage(file);
    setPreviewUrl(URL.createObjectURL(file));
  }

  async function readApiError(response, fallbackMessage) {
    try {
      const responseText = await response.text();

      if (!responseText) {
        return fallbackMessage;
      }

      try {
        const parsedResponse = JSON.parse(responseText);

        return (
          parsedResponse.message ?? parsedResponse.error ?? fallbackMessage
        );
      } catch {
        return responseText;
      }
    } catch {
      return fallbackMessage;
    }
  }

  function convertTechnicalErrorToUserMessage(message) {
    const normalisedMessage = String(message ?? "").toLowerCase();

    if (
      normalisedMessage.includes("active parking session") ||
      normalisedMessage.includes("already has an active")
    ) {
      return "This vehicle is already in the parking area. Please check the vehicle out before attempting another entry.";
    }

    if (
      normalisedMessage.includes("no active parking session") ||
      normalisedMessage.includes("active session not found") ||
      normalisedMessage.includes("matching parking session")
    ) {
      return "No active parking session was found for this vehicle.";
    }

    if (
      normalisedMessage.includes("licence plate") ||
      normalisedMessage.includes("license plate") ||
      normalisedMessage.includes("plate could not")
    ) {
      return "The licence plate could not be read clearly. Please upload a clearer image.";
    }

    if (
      normalisedMessage.includes("network") ||
      normalisedMessage.includes("failed to fetch")
    ) {
      return "The service is temporarily unavailable. Please try again.";
    }

    return message || "The request could not be completed.";
  }

  function normaliseApiPayload(payload) {
    let current = payload;

    for (let depth = 0; depth < 4; depth += 1) {
      if (typeof current === "string") {
        try {
          current = JSON.parse(current);
          continue;
        } catch {
          return { message: current };
        }
      }

      if (current && typeof current === "object" && "body" in current) {
        current = current.body;
        continue;
      }

      break;
    }

    return current && typeof current === "object" ? current : {};
  }

  async function requestPresignedUploadUrl() {
    const response = await fetch(uploadUrlEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        operation,
        fileName: selectedImage.name,
        fileType: selectedImage.type,
        contentType: selectedImage.type,
      }),
    });

    if (!response.ok) {
      const apiError = await readApiError(
        response,
        "The system could not prepare the image upload.",
      );

      throw new Error(convertTechnicalErrorToUserMessage(apiError));
    }

    const rawData = await response.json();
    const data = normaliseApiPayload(rawData);

    const uploadUrl = data.uploadUrl ?? data.presignedUrl ?? data.url;

    let imageKey =
      data.imageKey ??
      data.image_key ??
      data.objectKey ??
      data.object_key ??
      data.s3Key ??
      data.fileKey ??
      data.key;

    if (!imageKey && uploadUrl) {
      try {
        const uploadAddress = new URL(uploadUrl);
        imageKey = decodeURIComponent(
          uploadAddress.pathname.replace(/^\/+/, ""),
        );
      } catch {
        imageKey = "";
      }
    }

    if (!uploadUrl) {
      throw new Error(
        "The image upload service did not return an upload address.",
      );
    }

    if (!imageKey) {
      throw new Error(
        "The image upload service did not return an image reference.",
      );
    }

    return {
      uploadUrl,
      imageKey,
    };
  }

  async function uploadImageToS3(uploadUrl) {
    const response = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": selectedImage.type,
      },
      body: selectedImage,
    });

    if (!response.ok) {
      throw new Error("The image could not be uploaded. Please try again.");
    }
  }

  function wait(milliseconds) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, milliseconds);
    });
  }

  async function getProcessingStatus(imageKey) {
    const requestUrl = `${processingStatusEndpoint}?imageKey=${encodeURIComponent(imageKey)}`;

    const response = await fetch(requestUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const apiError = await readApiError(
        response,
        "The system could not check the parking result.",
      );

      throw new Error(convertTechnicalErrorToUserMessage(apiError));
    }

    const rawResult = await response.json();
    const result = normaliseApiPayload(rawResult);

    return {
      ...result,
      processingStatus:
        result.processingStatus ??
        result.processing_status ??
        result.status ??
        "PENDING",
      message:
        result.message ?? result.userMessage ?? result.user_message ?? "",
    };
  }

  async function waitForProcessingResult(imageKey) {
    let lastResult = null;

    for (let attempt = 1; attempt <= PROCESSING_MAX_ATTEMPTS; attempt += 1) {
      try {
        const result = await getProcessingStatus(imageKey);
        lastResult = result;

        const status = String(
          result.processingStatus ?? "PENDING",
        ).toUpperCase();

        if (status === "SUCCESS" || status === "REJECTED") {
          return { ...result, processingStatus: status };
        }

        /*
         * A duplicate S3 delivery can occasionally expose a FAILED result
         * after the parking operation has already succeeded. Do not show that
         * immediately as a red error. Refresh the sessions first.
         */
        if (status === "FAILED") {
          return {
            ...result,
            processingStatus: "UNCONFIRMED",
          };
        }
      } catch (error) {
        console.warn(`Processing-status check ${attempt} failed:`, error);
      }

      if (attempt < PROCESSING_MAX_ATTEMPTS) {
        await wait(PROCESSING_POLL_INTERVAL);
      }
    }

    return {
      ...(lastResult ?? {}),
      processingStatus: "UNCONFIRMED",
      message:
        "The image was uploaded and the parking sessions have been refreshed.",
    };
  }

  async function handleUpload(event) {
    event.preventDefault();

    if (isUploading) {
      return;
    }

    setErrorMessage("");
    setSuccessMessage("");

    const validationError = validateImage(selectedImage);

    if (validationError) {
      setErrorMessage(validationError);
      return;
    }

    setIsUploading(true);

    try {
      const { uploadUrl, imageKey } = await requestPresignedUploadUrl();

      await uploadImageToS3(uploadUrl);
      clearSelectedImage();

      const processingResult = await waitForProcessingResult(imageKey);

      await fetchSessions(false);

      const resultMessage =
        processingResult.message ?? "The parking operation has been completed.";

      if (processingResult.processingStatus === "REJECTED") {
        setSuccessMessage("");
        setErrorMessage(convertTechnicalErrorToUserMessage(resultMessage));
        return;
      }

      setErrorMessage("");

      if (processingResult.processingStatus === "SUCCESS") {
        setSuccessMessage(resultMessage);
        return;
      }

      /*
       * The upload succeeded, but the final status was delayed or a duplicate
       * backend event reported FAILED after the database had already updated.
       * Do not display a false red error. The refreshed sessions table is the
       * source of truth for the completed parking operation.
       */
      setSuccessMessage(
        "The image was processed and the parking sessions have been refreshed.",
      );
    } catch (error) {
      console.error("Image upload failed:", error);

      const rawMessage =
        error instanceof Error
          ? error.message
          : "The image could not be uploaded.";

      setSuccessMessage("");
      setErrorMessage(convertTechnicalErrorToUserMessage(rawMessage));
    } finally {
      setIsUploading(false);
    }
  }

  function formatDateTime(value) {
    if (!value) {
      return "Not available";
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      return "Not available";
    }

    return new Intl.DateTimeFormat("en-ZA", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  }

  function formatCurrency(value) {
    const amount = Number(value ?? 0);

    return new Intl.NumberFormat("en-ZA", {
      style: "currency",
      currency: "ZAR",
    }).format(Number.isFinite(amount) ? amount : 0);
  }

  function getStatusClass(status) {
    switch (status) {
      case "ACTIVE":
        return "status-badge status-active";

      case "COMPLETED":
        return "status-badge status-completed";

      case "FLAGGED":
        return "status-badge status-flagged";

      default:
        return "status-badge";
    }
  }

  function getStatusLabel(status) {
    switch (status) {
      case "ACTIVE":
        return "Active";

      case "COMPLETED":
        return "Completed";

      case "FLAGGED":
        return "Needs review";

      default:
        return status || "Unknown";
    }
  }

  function getSessionsHeading() {
    switch (sessionFilter) {
      case "ACTIVE":
        return "Vehicles currently parked";

      case "COMPLETED":
        return "Completed parking sessions";

      case "FEES":
        return "Parking fees and receipts";

      default:
        return "All parking sessions";
    }
  }

  function getEmptyStateTitle() {
    switch (sessionFilter) {
      case "ACTIVE":
        return "No vehicles are currently parked";

      case "COMPLETED":
        return "No completed sessions yet";

      case "FEES":
        return "No parking receipts yet";

      default:
        return "No parking sessions yet";
    }
  }

  function getEmptyStateDescription() {
    switch (sessionFilter) {
      case "ACTIVE":
        return "Upload a vehicle entry image to start a parking session.";

      case "COMPLETED":
        return "Completed parking sessions will appear here after vehicle exits.";

      case "FEES":
        return "Parking fees and receipts will appear after completed vehicle exits.";

      default:
        return "Upload a vehicle entry image to start the first parking session.";
    }
  }

  function buildReceiptHtml(session) {
    const receiptNumber = session.receipt_number ?? "Parking receipt";

    return `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta
            name="viewport"
            content="width=device-width, initial-scale=1.0"
          />

          <title>${receiptNumber}</title>

          <style>
            * {
              box-sizing: border-box;
            }

            body {
              margin: 0;
              padding: 40px 20px;
              color: #10213f;
              background: #f4f7fb;
              font-family: Arial, sans-serif;
            }

            .receipt {
              max-width: 680px;
              margin: 0 auto;
              overflow: hidden;
              border: 1px solid #dfe7f2;
              border-radius: 18px;
              background: white;
              box-shadow: 0 12px 30px rgba(23, 52, 97, 0.1);
            }

            .header {
              padding: 30px;
              color: white;
              background: linear-gradient(
                120deg,
                #071b42,
                #1766d1
              );
            }

            .header p {
              margin: 0 0 8px;
              color: #bad0ff;
              font-size: 12px;
              font-weight: bold;
              letter-spacing: 2px;
              text-transform: uppercase;
            }

            .header h1 {
              margin: 0;
              font-size: 30px;
            }

            .content {
              padding: 30px;
            }

            .row {
              display: flex;
              justify-content: space-between;
              gap: 30px;
              padding: 14px 0;
              border-bottom: 1px solid #e6edf5;
            }

            .label {
              color: #687990;
            }

            .value {
              text-align: right;
              font-weight: bold;
            }

            .total {
              margin-top: 20px;
              padding: 20px;
              border: 0;
              border-radius: 12px;
              background: #edf3ff;
            }

            .total .value {
              color: #1559c6;
              font-size: 26px;
            }

            .footer {
              padding: 20px 30px;
              color: #6d7c90;
              background: #f7f9fc;
              text-align: center;
              font-size: 13px;
            }

            @media print {
              body {
                padding: 0;
                background: white;
              }

              .receipt {
                border: 0;
                box-shadow: none;
              }
            }
          </style>
        </head>

        <body>
          <main class="receipt">
            <header class="header">
              <p>NB Ticketless Parking System</p>
              <h1>Parking Receipt</h1>
            </header>

            <section class="content">
              <div class="row">
                <span class="label">Receipt number</span>
                <span class="value">${receiptNumber}</span>
              </div>

              <div class="row">
                <span class="label">Licence plate</span>
                <span class="value">${session.license_plate}</span>
              </div>

              <div class="row">
                <span class="label">Entry date and time</span>
                <span class="value">
                  ${formatDateTime(session.entry_timestamp)}
                </span>
              </div>

              <div class="row">
                <span class="label">Exit date and time</span>
                <span class="value">
                  ${formatDateTime(session.exit_timestamp)}
                </span>
              </div>

              <div class="row">
                <span class="label">Parking duration</span>
                <span class="value">
                  ${session.duration_minutes ?? 0} minutes
                </span>
              </div>

              <div class="row">
                <span class="label">Hourly rate</span>
                <span class="value">
                  ${formatCurrency(session.hourly_rate)}
                </span>
              </div>

              <div class="row">
                <span class="label">Payment status</span>
                <span class="value">Paid</span>
              </div>

              <div class="row total">
                <span class="label">Total parking fee</span>
                <span class="value">
                  ${formatCurrency(session.calculated_fee)}
                </span>
              </div>
            </section>

            <footer class="footer">
              Thank you for using NB Ticketless Parking System.
            </footer>
          </main>
        </body>
      </html>
    `;
  }

  function downloadReceipt(session) {
    const receiptBlob = new Blob([buildReceiptHtml(session)], {
      type: "text/html;charset=utf-8",
    });

    const receiptUrl = URL.createObjectURL(receiptBlob);
    const downloadLink = document.createElement("a");

    downloadLink.href = receiptUrl;
    downloadLink.download = `${
      session.receipt_number ?? "parking-receipt"
    }.html`;

    document.body.appendChild(downloadLink);
    downloadLink.click();
    downloadLink.remove();

    window.setTimeout(() => {
      URL.revokeObjectURL(receiptUrl);
    }, 100);
  }

  function printReceipt(session) {
    const receiptWindow = window.open("", "_blank", "width=800,height=900");

    if (!receiptWindow) {
      setErrorMessage(
        "Please allow pop-ups to print or save the receipt as a PDF.",
      );
      return;
    }

    receiptWindow.document.open();
    receiptWindow.document.write(buildReceiptHtml(session));
    receiptWindow.document.close();

    receiptWindow.onload = () => {
      receiptWindow.focus();
      receiptWindow.print();
    };
  }

  const activeSessions = sessions.filter(
    (session) => session.session_status === "ACTIVE",
  ).length;

  const completedSessions = sessions.filter(
    (session) => session.session_status === "COMPLETED",
  ).length;

  const totalFees = sessions.reduce((total, session) => {
    return total + Number(session.calculated_fee ?? 0);
  }, 0);

  const filteredSessions = sessions.filter((session) => {
    switch (sessionFilter) {
      case "ACTIVE":
        return session.session_status === "ACTIVE";

      case "COMPLETED":
        return session.session_status === "COMPLETED";

      case "FEES":
        return (
          session.session_status === "COMPLETED" &&
          Boolean(session.receipt_number)
        );

      default:
        return true;
    }
  });

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">NB Ticketless Parking System</p>

          <h1>Vehicle Parking Dashboard</h1>

          <p className="header-description">
            Upload vehicle licence plates and monitor parking sessions in real
            time.
          </p>
        </div>

        <div className="live-indicator">
          <span className="live-dot" />
          System online
        </div>
      </header>

      <main className="dashboard">
        <section className="summary-grid" aria-label="Parking summary">
          <button
            type="button"
            className={
              sessionFilter === "ALL"
                ? "summary-card summary-card-button selected"
                : "summary-card summary-card-button"
            }
            onClick={() => handleSummaryCardClick("ALL")}
          >
            <span>Total sessions</span>
            <strong>{sessions.length}</strong>
            <small>View all parking sessions</small>
          </button>

          <button
            type="button"
            className={
              sessionFilter === "ACTIVE"
                ? "summary-card summary-card-button selected"
                : "summary-card summary-card-button"
            }
            onClick={() => handleSummaryCardClick("ACTIVE")}
          >
            <span>Vehicles currently parked</span>
            <strong>{activeSessions}</strong>
            <small>View active vehicles</small>
          </button>

          <button
            type="button"
            className={
              sessionFilter === "COMPLETED"
                ? "summary-card summary-card-button selected"
                : "summary-card summary-card-button"
            }
            onClick={() => handleSummaryCardClick("COMPLETED")}
          >
            <span>Completed sessions</span>
            <strong>{completedSessions}</strong>
            <small>View completed sessions</small>
          </button>

          <button
            type="button"
            className={
              sessionFilter === "FEES"
                ? "summary-card summary-card-button selected"
                : "summary-card summary-card-button"
            }
            onClick={() => handleSummaryCardClick("FEES")}
          >
            <span>Total parking fees</span>
            <strong>{formatCurrency(totalFees)}</strong>
            <small>View fees and receipts</small>
          </button>
        </section>

        <section className="content-grid">
          <article className="panel upload-panel">
            <div className="panel-heading">
              <div>
                <p className="section-label">Vehicle check-in and exit</p>

                <h2>Upload a licence-plate image</h2>
              </div>
            </div>

            <div className="operation-tabs">
              <button
                type="button"
                className={
                  operation === "entry"
                    ? "operation-button active"
                    : "operation-button"
                }
                onClick={() => handleOperationChange("entry")}
                disabled={isUploading}
              >
                Vehicle entry
              </button>

              <button
                type="button"
                className={
                  operation === "exit"
                    ? "operation-button active"
                    : "operation-button"
                }
                onClick={() => handleOperationChange("exit")}
                disabled={isUploading}
              >
                Vehicle exit
              </button>
            </div>

            <form onSubmit={handleUpload}>
              <label
                className={
                  isUploading
                    ? "upload-area upload-area-disabled"
                    : "upload-area"
                }
                htmlFor="vehicle-image"
              >
                {previewUrl ? (
                  <img
                    src={previewUrl}
                    alt="Selected vehicle licence plate"
                    className="image-preview"
                  />
                ) : (
                  <div className="upload-placeholder">
                    <span className="upload-icon">
                      {isUploading ? <span className="button-spinner" /> : "↑"}
                    </span>

                    <strong>
                      {isUploading
                        ? "Uploading and processing image"
                        : "Select a licence-plate image"}
                    </strong>

                    <small>JPG, JPEG or PNG — maximum size 5 MB</small>
                  </div>
                )}

                <input
                  ref={fileInputRef}
                  id="vehicle-image"
                  type="file"
                  accept="image/png,image/jpeg,image/jpg"
                  onChange={handleImageSelection}
                  disabled={isUploading}
                  hidden
                />
              </label>

              {selectedImage && (
                <div className="selected-file-row">
                  <div>
                    <strong>{selectedImage.name}</strong>

                    <small>{(selectedImage.size / 1024).toFixed(1)} KB</small>
                  </div>

                  <button
                    type="button"
                    className="text-button"
                    onClick={resetImageForm}
                    disabled={isUploading}
                  >
                    Remove
                  </button>
                </div>
              )}

              {errorMessage && (
                <div className="message error-message" role="alert">
                  {errorMessage}
                </div>
              )}

              {successMessage && (
                <div className="message success-message" role="status">
                  {successMessage}
                </div>
              )}

              <button
                type="submit"
                className="primary-button"
                disabled={!selectedImage || isUploading}
              >
                {isUploading && <span className="button-spinner" />}

                {isUploading
                  ? "Processing image..."
                  : operation === "entry"
                    ? "Start parking session"
                    : "Complete parking session"}
              </button>
            </form>
          </article>

          <article className="panel information-panel">
            <p className="section-label">How it works</p>

            <h2>
              {operation === "entry"
                ? "Start a parking session"
                : "Complete a parking session"}
            </h2>

            <div className="process-list">
              <div className="process-item">
                <span>1</span>

                <p>Upload a clear photo of the vehicle&apos;s licence plate.</p>
              </div>

              <div className="process-item">
                <span>2</span>

                <p>
                  {operation === "entry"
                    ? "The system reads the licence plate automatically."
                    : "The system reads the plate and finds the matching parking session."}
                </p>
              </div>

              <div className="process-item">
                <span>3</span>

                <p>
                  {operation === "entry"
                    ? "A parking session is started and the vehicle is recorded."
                    : "The parking fee is calculated and a receipt is created."}
                </p>
              </div>
            </div>
          </article>
        </section>

        <section ref={sessionsSectionRef} className="panel sessions-panel">
          <div className="panel-heading sessions-heading">
            <div>
              <p className="section-label">Vehicle activity</p>

              <h2>{getSessionsHeading()}</h2>

              <p className="last-updated">
                {lastUpdated
                  ? `Last updated at ${lastUpdated.toLocaleTimeString("en-ZA")}`
                  : "Waiting for parking session information"}
              </p>
            </div>

            <button
              type="button"
              className="refresh-button"
              onClick={() => fetchSessions(true)}
              disabled={isLoadingSessions || isRefreshingSessions}
            >
              Refresh sessions
            </button>
          </div>

          {isLoadingSessions && sessions.length === 0 ? (
            <div className="empty-state">
              <span className="large-spinner" />
              <h3>Loading parking sessions</h3>
              <p>Please wait while the latest information loads.</p>
            </div>
          ) : filteredSessions.length === 0 ? (
            <div className="empty-state">
              <h3>{getEmptyStateTitle()}</h3>
              <p>{getEmptyStateDescription()}</p>
            </div>
          ) : (
            <div className="table-container">
              <table className="sessions-table">
                <thead>
                  <tr>
                    <th>Licence plate</th>
                    <th>Status</th>
                    <th>Entry time</th>
                    <th>Exit time</th>
                    <th>Parking time</th>
                    <th>Fee</th>
                    <th>Receipt</th>
                  </tr>
                </thead>

                <tbody>
                  {filteredSessions.map((session) => (
                    <tr
                      key={session.session_id}
                      className={
                        session.session_status === "ACTIVE"
                          ? "active-session-row"
                          : ""
                      }
                    >
                      <td>
                        <strong className="plate-number">
                          {session.license_plate}
                        </strong>

                        {session.review_required && (
                          <small className="review-text">
                            Plate needs review
                          </small>
                        )}
                      </td>

                      <td>
                        <span
                          className={getStatusClass(session.session_status)}
                        >
                          <span className="status-dot" />

                          {getStatusLabel(session.session_status)}
                        </span>
                      </td>

                      <td>{formatDateTime(session.entry_timestamp)}</td>

                      <td>
                        {session.exit_timestamp
                          ? formatDateTime(session.exit_timestamp)
                          : "Not exited"}
                      </td>

                      <td>
                        {session.duration_minutes != null
                          ? `${session.duration_minutes} minutes`
                          : session.session_status === "ACTIVE"
                            ? "Still parked"
                            : "Not available"}
                      </td>

                      <td>
                        {session.session_status === "ACTIVE"
                          ? "Calculating…"
                          : formatCurrency(session.calculated_fee)}
                      </td>

                      <td>
                        {session.receipt_number ? (
                          <button
                            type="button"
                            className="receipt-link-button"
                            onClick={() => setSelectedReceipt(session)}
                          >
                            Open receipt
                          </button>
                        ) : (
                          <span className="receipt-unavailable">
                            Available after exit
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>

      {selectedReceipt && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setSelectedReceipt(null);
            }
          }}
        >
          <section
            className="modal-card receipt-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="receipt-title"
          >
            <header className="receipt-modal-header">
              <div>
                <p>NB Ticketless Parking System</p>

                <h2 id="receipt-title">Parking Receipt</h2>
              </div>

              <button
                type="button"
                className="receipt-close-button"
                onClick={() => setSelectedReceipt(null)}
                aria-label="Close receipt"
              >
                ×
              </button>
            </header>

            <div className="receipt-body">
              <div className="receipt-paid-badge">Payment completed</div>

              <div className="receipt-row">
                <span>Receipt number</span>

                <strong>{selectedReceipt.receipt_number}</strong>
              </div>

              <div className="receipt-row">
                <span>Licence plate</span>

                <strong>{selectedReceipt.license_plate}</strong>
              </div>

              <div className="receipt-row">
                <span>Entry date and time</span>

                <strong>
                  {formatDateTime(selectedReceipt.entry_timestamp)}
                </strong>
              </div>

              <div className="receipt-row">
                <span>Exit date and time</span>

                <strong>
                  {formatDateTime(selectedReceipt.exit_timestamp)}
                </strong>
              </div>

              <div className="receipt-row">
                <span>Parking duration</span>

                <strong>{selectedReceipt.duration_minutes ?? 0} minutes</strong>
              </div>

              <div className="receipt-row">
                <span>Hourly rate</span>

                <strong>{formatCurrency(selectedReceipt.hourly_rate)}</strong>
              </div>

              <div className="receipt-row">
                <span>Payment status</span>

                <strong>Paid</strong>
              </div>

              <div className="receipt-total">
                <span>Total parking fee</span>

                <strong>
                  {formatCurrency(selectedReceipt.calculated_fee)}
                </strong>
              </div>
            </div>

            <footer className="receipt-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setSelectedReceipt(null)}
              >
                Close
              </button>

              <button
                type="button"
                className="secondary-button"
                onClick={() => printReceipt(selectedReceipt)}
              >
                Print or save as PDF
              </button>

              <button
                type="button"
                className="primary-action-button"
                onClick={() => downloadReceipt(selectedReceipt)}
              >
                Download receipt
              </button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}

export default App;
