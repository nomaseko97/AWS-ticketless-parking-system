import { useEffect, useRef, useState } from "react";
import "./App.css";

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const UPLOAD_URL_ENDPOINT = import.meta.env.VITE_UPLOAD_URL_ENDPOINT;

function App() {
  const [operation, setOperation] = useState("entry");
  const [selectedImage, setSelectedImage] = useState(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [isUploading, setIsUploading] = useState(false);

  const fileInputRef = useRef(null);

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  function resetImage() {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }

    setSelectedImage(null);
    setPreviewUrl("");
    setErrorMessage("");
    setSuccessMessage("");

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function handleOperationChange(selectedOperation) {
    setOperation(selectedOperation);
    resetImage();
  }

  function validateAndSelectImage(file) {
    setErrorMessage("");
    setSuccessMessage("");

    if (!file) {
      return;
    }

    const allowedTypes = ["image/jpeg", "image/png", "image/webp"];

    if (!allowedTypes.includes(file.type)) {
      setErrorMessage("Please select a JPG, PNG or WebP image.");
      return;
    }

    if (file.size > MAX_FILE_SIZE) {
      setErrorMessage("The image must be smaller than 5 MB.");
      return;
    }

    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }

    setSelectedImage(file);
    setPreviewUrl(URL.createObjectURL(file));
  }

  function handleImageChange(event) {
    validateAndSelectImage(event.target.files[0]);
  }

  function handleDrop(event) {
    event.preventDefault();
    validateAndSelectImage(event.dataTransfer.files[0]);
  }

  async function handleUpload() {
    setErrorMessage("");
    setSuccessMessage("");

    if (!selectedImage) {
      setErrorMessage(
        `Please choose a vehicle ${operation} image before uploading.`,
      );
      return;
    }

    if (!UPLOAD_URL_ENDPOINT) {
      setErrorMessage(
        "The upload API endpoint is not configured. Check the frontend .env file.",
      );
      return;
    }

    setIsUploading(true);

    try {
      /*
       * Step 1:
       * Request a temporary S3 upload URL from API Gateway and Lambda.
       */
      const urlResponse = await fetch(UPLOAD_URL_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          operation,
          contentType: selectedImage.type,
        }),
      });

      const responseText = await urlResponse.text();

      let urlData;

      try {
        urlData = responseText ? JSON.parse(responseText) : {};
      } catch {
        throw new Error("The upload API returned an invalid response.");
      }

      if (!urlResponse.ok) {
        throw new Error(
          urlData.message ||
            `Could not create an upload URL. Status: ${urlResponse.status}`,
        );
      }

      if (!urlData.uploadUrl || !urlData.objectKey) {
        throw new Error(
          "The upload API did not return the required upload information.",
        );
      }

      /*
       * Step 2:
       * Upload the selected image directly to the private S3 bucket.
       */
      const uploadResponse = await fetch(urlData.uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": selectedImage.type,
        },
        body: selectedImage,
      });

      if (!uploadResponse.ok) {
        throw new Error(
          `The image could not be uploaded to S3. Status: ${uploadResponse.status}`,
        );
      }

      console.log("Image uploaded successfully:", {
        operation,
        objectKey: urlData.objectKey,
      });

      setSuccessMessage(
        `Vehicle ${operation} image uploaded successfully.`,
      );
    } catch (error) {
      console.error("Image upload failed:", error);

      setErrorMessage(
        error instanceof Error
          ? error.message
          : "The image could not be uploaded.",
      );
    } finally {
      setIsUploading(false);
    }
  }

  const isEntry = operation === "entry";

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <div className="brand-icon" aria-hidden="true">
            P
          </div>

          <div>
            <p className="brand-name">ParkFlow</p>
            <p className="brand-description">
              Ticketless Parking Management
            </p>
          </div>
        </div>

        <div className="system-status">
          <span className="status-dot" />
          System online
        </div>
      </header>

      <main className="page-content">
        <section className="hero-section">
          <p className="eyebrow">Smart parking operations</p>

          <h1>Capture a vehicle movement</h1>

          <p className="hero-description">
            Select whether the vehicle is entering or exiting, then upload a
            clear image of its licence plate.
          </p>
        </section>

        <section className="parking-card">
          <div className="section-heading">
            <div>
              <span className="step-number">1</span>
              <h2>Select parking operation</h2>
            </div>

            <p>Choose the correct vehicle movement.</p>
          </div>

          <div className="operation-grid">
            <button
              type="button"
              className={`operation-card ${
                isEntry ? "operation-card--active" : ""
              }`}
              onClick={() => handleOperationChange("entry")}
              aria-pressed={isEntry}
              disabled={isUploading}
            >
              <span className="operation-icon operation-icon--entry">
                <svg
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path d="M10 17l5-5-5-5v10z" />
                  <path d="M19 19H5V5h14v4h-2V7H7v10h10v-2h2v4z" />
                </svg>
              </span>

              <span className="operation-content">
                <strong>Vehicle Entry</strong>
                <span>
                  Register a vehicle entering the parking facility.
                </span>
              </span>

              <span className="selection-indicator">
                {isEntry ? "✓" : ""}
              </span>
            </button>

            <button
              type="button"
              className={`operation-card ${
                !isEntry ? "operation-card--active" : ""
              }`}
              onClick={() => handleOperationChange("exit")}
              aria-pressed={!isEntry}
              disabled={isUploading}
            >
              <span className="operation-icon operation-icon--exit">
                <svg
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path d="M14 7l-5 5 5 5V7z" />
                  <path d="M5 5h14v14H5v-4h2v2h10V7H7v2H5V5z" />
                </svg>
              </span>

              <span className="operation-content">
                <strong>Vehicle Exit</strong>
                <span>Complete an active parking session.</span>
              </span>

              <span className="selection-indicator">
                {!isEntry ? "✓" : ""}
              </span>
            </button>
          </div>

          <div className="divider" />

          <div className="section-heading">
            <div>
              <span className="step-number">2</span>

              <h2>
                Upload vehicle {isEntry ? "entry" : "exit"} image
              </h2>
            </div>

            <p>Use a clear image where the licence plate is visible.</p>
          </div>

          {!selectedImage ? (
            <div
              className="upload-zone"
              onDragOver={(event) => event.preventDefault()}
              onDrop={handleDrop}
            >
              <div className="upload-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" focusable="false">
                  <path d="M19 13v6H5v-6H3v6c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-6h-2z" />
                  <path d="M11 16h2V8h3l-4-4-4 4h3v8z" />
                </svg>
              </div>

              <h3>Upload licence plate image</h3>

              <p>
                Drag and drop an image here, or browse your computer.
              </p>

              <label className="browse-button">
                Choose image

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={handleImageChange}
                  disabled={isUploading}
                />
              </label>

              <span className="file-guidance">
                JPG, PNG or WebP · Maximum 5 MB
              </span>
            </div>
          ) : (
            <div className="image-preview-card">
              <div className="image-preview-wrapper">
                <img
                  src={previewUrl}
                  alt={`Vehicle ${operation} licence plate preview`}
                />

                <span
                  className={`operation-badge ${
                    isEntry
                      ? "operation-badge--entry"
                      : "operation-badge--exit"
                  }`}
                >
                  {isEntry ? "Entry image" : "Exit image"}
                </span>
              </div>

              <div className="file-details">
                <div>
                  <p className="file-name">{selectedImage.name}</p>

                  <p className="file-size">
                    {(selectedImage.size / 1024 / 1024).toFixed(2)} MB
                  </p>
                </div>

                <button
                  type="button"
                  className="remove-button"
                  onClick={resetImage}
                  disabled={isUploading}
                >
                  Remove
                </button>
              </div>
            </div>
          )}

          {errorMessage && (
            <div className="error-message" role="alert">
              {errorMessage}
            </div>
          )}

          {successMessage && (
            <div className="success-message" role="status">
              {successMessage}
            </div>
          )}

          <div className="action-area">
            <div className="security-note">
              <span aria-hidden="true">🔒</span>
              Images will be uploaded securely to AWS.
            </div>

            <button
              type="button"
              className="upload-button"
              onClick={handleUpload}
              disabled={!selectedImage || isUploading}
            >
              {isUploading
                ? "Uploading..."
                : `Upload ${isEntry ? "Entry" : "Exit"} Image`}

              {!isUploading && <span aria-hidden="true">→</span>}
            </button>
          </div>
        </section>

        <footer className="page-footer">
          <p>ParkFlow Ticketless Parking System</p>
          <p>Powered by AWS cloud services</p>
        </footer>
      </main>
    </div>
  );
}

export default App;