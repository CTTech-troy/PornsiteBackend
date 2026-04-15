import { getFirebaseDb } from "../config/firebase.js";

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeString(item)).filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function buildContentRemovalPayload(body, existing = {}) {
  return {
    fullname: normalizeString(body.fullname ?? existing.fullname),
    company: normalizeString(body.Company ?? body.company ?? existing.company),
    emailAddress: normalizeString(
      body.EmailAddress ?? body.emailAddress ?? existing.emailAddress
    ).toLowerCase(),
    phoneNumber: normalizeString(
      body.PhoneNumber ?? body.phoneNumber ?? existing.phoneNumber
    ),
    relationshipToContent: normalizeString(
      body.Relationship2Content ??
        body.relationshipToContent ??
        existing.relationshipToContent
    ),
    urlToContent: normalizeString(
      body.URL2Content ?? body.urlToContent ?? existing.urlToContent
    ),
    additionalUrls: normalizeArray(
      body.AdditionalURLs ?? body.additionalUrls ?? existing.additionalUrls
    ),
    title: normalizeString(body.Title ?? body.title ?? existing.title),
    reason: normalizeString(body.Reason ?? body.reason ?? existing.reason),
    explanation: normalizeString(
      body.Explanation ?? body.explanation ?? existing.explanation
    ),
    evidence: normalizeArray(body.Evidence ?? body.evidence ?? existing.evidence),
    consent1: Boolean(body.constent1 ?? body.consent1 ?? existing.consent1),
    consent2: Boolean(body.consent2 ?? body.consent2 ?? existing.consent2),
    digitalSignature: normalizeString(
      body.DigitalSignature ??
        body.digitalSignature ??
        existing.digitalSignature
    ),
    date: normalizeString(body.Date ?? body.date ?? existing.date),
  };
}

function validateContentRemoval(payload) {
  if (!payload.fullname) return "Full name is required.";
  if (!payload.emailAddress) return "Email address is required.";
  if (!payload.relationshipToContent) return "Relationship to content is required.";
  if (!payload.urlToContent) return "URL to content is required.";
  if (!payload.reason) return "Reason is required.";
  if (!payload.explanation) return "Explanation is required.";
  if (!payload.digitalSignature) return "Digital signature is required.";
  if (!payload.date) return "Date is required.";
  if (!payload.consent1) return "Consent 1 must be accepted.";
  if (!payload.consent2) return "Consent 2 must be accepted.";
  return null;
}

export async function createContentRemoval(req, res) {
  try {
    const db = getFirebaseDb();

    if (!db) {
      return res.status(503).json({
        success: false,
        message: "Database service is temporarily unavailable.",
      });
    }

    const payload = buildContentRemovalPayload(req.body);
    const validationError = validateContentRemoval(payload);

    if (validationError) {
      return res.status(400).json({
        success: false,
        message: validationError,
      });
    }

    const docRef = db.collection("contentRemovalRequests").doc();

    const data = {
      id: docRef.id,
      ...payload,
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await docRef.set(data);

    console.log(`✅ Removal content uploaded successfully - ID: ${data.id}`);

    return res.status(201).json({
      success: true,
      message: "Content removal request created successfully.",
      data,
    });
  } catch (error) {
    console.error("createContentRemoval error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create content removal request.",
      error: error.message,
    });
  }
}

export async function getAllContentRemovals(req, res) {
  try {
    const db = getFirebaseDb();

    if (!db) {
      return res.status(503).json({
        success: false,
        message: "Database service is temporarily unavailable.",
      });
    }

    const snapshot = await db
      .collection("contentRemovalRequests")
      .orderBy("createdAt", "desc")
      .get();

    const requests = snapshot.docs.map((doc) => doc.data());

    return res.status(200).json({
      success: true,
      count: requests.length,
      data: requests,
    });
  } catch (error) {
    console.error("getAllContentRemovals error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch content removal requests.",
      error: error.message,
    });
  }
}

export async function getContentRemovalById(req, res) {
  try {
    const { id } = req.params;
    const db = getFirebaseDb();

    if (!db) {
      return res.status(503).json({
        success: false,
        message: "Database service is temporarily unavailable.",
      });
    }

    const doc = await db.collection("contentRemovalRequests").doc(id).get();

    if (!doc.exists) {
      return res.status(404).json({
        success: false,
        message: "Content removal request not found.",
      });
    }

    return res.status(200).json({
      success: true,
      data: doc.data(),
    });
  } catch (error) {
    console.error("getContentRemovalById error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch content removal request.",
      error: error.message,
    });
  }
}

export async function updateContentRemoval(req, res) {
  try {
    const { id } = req.params;
    const db = getFirebaseDb();

    if (!db) {
      return res.status(503).json({
        success: false,
        message: "Database service is temporarily unavailable.",
      });
    }

    const docRef = db.collection("contentRemovalRequests").doc(id);
    const existingDoc = await docRef.get();

    if (!existingDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "Content removal request not found.",
      });
    }

    const existingData = existingDoc.data();
    const payload = buildContentRemovalPayload(req.body, existingData);
    const validationError = validateContentRemoval(payload);

    if (validationError) {
      return res.status(400).json({
        success: false,
        message: validationError,
      });
    }

    const updatedData = {
      ...existingData,
      ...payload,
      updatedAt: new Date().toISOString(),
    };

    await docRef.update(updatedData);

    return res.status(200).json({
      success: true,
      message: "Content removal request updated successfully.",
      data: updatedData,
    });
  } catch (error) {
    console.error("updateContentRemoval error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update content removal request.",
      error: error.message,
    });
  }
}

export async function deleteContentRemoval(req, res) {
  try {
    const { id } = req.params;
    const db = getFirebaseDb();

    if (!db) {
      return res.status(503).json({
        success: false,
        message: "Database service is temporarily unavailable.",
      });
    }

    const docRef = db.collection("contentRemovalRequests").doc(id);
    const existingDoc = await docRef.get();

    if (!existingDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "Content removal request not found.",
      });
    }

    await docRef.delete();

    return res.status(200).json({
      success: true,
      message: "Content removal request deleted successfully.",
    });
  } catch (error) {
    console.error("deleteContentRemoval error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to delete content removal request.",
      error: error.message,
    });
  }
}