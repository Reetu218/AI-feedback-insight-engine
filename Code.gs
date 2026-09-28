/**
 * AI Feedback Insight Engine
 * ---------------------------------------------------------------
 * Classifies employee exit interview & pulse survey feedback by
 * theme, sentiment and urgency using the Gemini API, and emails HR
 * instantly for High urgency cases.
 *
 * Setup (Project Settings -> Script Properties):
 *   GEMINI_API_KEY  : your Gemini API key from Google AI Studio
 *   HR_ALERT_EMAIL  : email address that receives urgent alerts
 *
 * Sheet columns (tab "Form Responses 1"):
 *   A Timestamp | B Survey Type | C Department | D Tenure |
 *   E Overall Satisfaction | F Main Feedback | G Manager Experience |
 *   H Anything Else | I Theme | J Sentiment | K Urgency |
 *   L AI_Summary | M Processed | N Human_Check | O Alert_Sent
 *
 * Run once: setupTriggers()
 * No secrets are stored in this file.
 */

// ===== SETTINGS =====
const MODELS = ["gemini-3.5-flash-lite", "gemini-flash-latest"];  // primary + backup
const SHEET_NAME = "Form Responses 1";
const MAX_RETRIES = 3;
const BATCH_SIZE = 10;
const TOTAL_COLUMNS = 15;  // A to O

const THEMES = [
  "Workload & Burnout",
  "Manager Behaviour",
  "Compensation & Benefits",
  "Career Growth",
  "Work-Life Balance",
  "Culture & Communication",
  "Onboarding & Training",
  "Tools & Resources",
  "Harassment & Misconduct",
  "Personal / External Reason",
  "Positive Feedback"
];
const SENTIMENTS = ["Positive", "Neutral", "Negative"];
const URGENCY_LEVELS = ["High", "Medium", "Low"];

// ===== GEMINI API CALL (with retry + model fallback) =====
function callGemini(prompt, jsonMode) {
  const apiKey = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!prompt) throw new Error("Do not run callGemini directly. Run another function.");
  if (!apiKey) throw new Error("API key not found. Check Script Properties.");

  const requestBody = { contents: [{ parts: [{ text: prompt }] }] };
  if (jsonMode) requestBody.generationConfig = { responseMimeType: "application/json" };

  for (const model of MODELS) {
    const url = "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent";

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const response = UrlFetchApp.fetch(url, {
        method: "post",
        contentType: "application/json",
        headers: { "x-goog-api-key": apiKey },
        payload: JSON.stringify(requestBody),
        muteHttpExceptions: true
      });

      const code = response.getResponseCode();
      const body = JSON.parse(response.getContentText());

      if (code === 200) return body.candidates[0].content.parts[0].text;

      // Busy (503) or rate limited (429): exponential backoff 2s, 4s, 8s
      if (code === 503 || code === 429) {
        const waitSec = Math.pow(2, attempt);
        Logger.log("⏳ " + model + " busy (" + code + "). Retrying in " + waitSec + "s...");
        Utilities.sleep(waitSec * 1000);
        continue;
      }
      throw new Error("API error " + code + ": " + JSON.stringify(body.error));
    }
    Logger.log("⚠️ " + model + " failed, trying backup model...");
  }
  throw new Error("All models are busy. Please try again later.");
}

// ===== CLASSIFICATION RULES =====
function getRules() {
  return `You are an experienced People Analytics specialist analyzing anonymous employee feedback.

For each feedback decide:
- "theme": choose EXACTLY ONE from this list: ${THEMES.join(", ")}
- "sentiment": one of: Positive, Neutral, Negative
- "urgency": one of: High, Medium, Low
- "summary": one sentence in simple English, maximum 20 words, no names

URGENCY RULES (follow strictly):
- High: ONLY for harassment, bullying, threats, discrimination, safety risks, or signs of serious mental health distress (anxiety, feeling unable to cope). HR must act within 24 hours.
- Medium: strong attrition risk signals like burnout, repeated unfair treatment, or pay/growth frustration.
- Low: general suggestions, mild complaints, positive feedback, or neutral reasons for leaving (relocation, studies).

Normal workload or target pressure alone is Medium, NOT High.
If feedback mentions multiple issues, pick the theme that is most serious.
If feedback mentions yelling, public humiliation, threats, bullying, or harassment by anyone (including a manager), the theme MUST be "Harassment & Misconduct", not "Manager Behaviour". Use "Manager Behaviour" only for issues like poor feedback, favouritism, lack of support, or cancelled 1:1s.`;
}

// ===== HELPERS =====
function validateResult(result) {
  if (!THEMES.includes(result.theme)) result.theme = "Other (check manually)";
  if (!SENTIMENTS.includes(result.sentiment)) result.sentiment = "Unclear";
  if (!URGENCY_LEVELS.includes(result.urgency)) result.urgency = "Medium";
  if (!result.summary) result.summary = "-";
  return result;
}

function parseJson(raw) {
  return JSON.parse(raw.replace(/```json|```/g, "").trim());
}

function getFeedbackText(rowValues) {
  return "Main Feedback: " + rowValues[5] + "\n" +
         "Manager Experience: " + rowValues[6] + "\n" +
         "Anything Else: " + (rowValues[7] || "-");
}

function getSheet() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
}

// ===== SINGLE ANALYSIS =====
function analyzeFeedback(feedback) {
  const prompt = getRules() +
    "\n\nReturn ONLY a JSON object with keys: theme, sentiment, urgency, summary." +
    "\n\nEmployee feedback:\n" + feedback;
  return validateResult(parseJson(callGemini(prompt, true)));
}

// ===== BATCH ANALYSIS (10 feedbacks per API call) =====
function analyzeBatch(items) {
  let prompt = getRules() +
    "\n\nYou will receive multiple feedbacks, each with an id." +
    "\nReturn ONLY a JSON array. Each element must have keys: id, theme, sentiment, urgency, summary." +
    "\nReturn exactly one element per feedback, using the same id.\n";

  items.forEach(item => {
    prompt += "\n--- Feedback id: " + item.id + " ---\n" + item.text + "\n";
  });

  const results = parseJson(callGemini(prompt, true));
  if (!Array.isArray(results)) throw new Error("AI did not return an array");

  const byId = {};
  results.forEach(r => { byId[String(r.id)] = validateResult(r); });
  return byId;
}

// ===== WRITE RESULT + SEND ALERT IF NEEDED =====
function writeResult(sheet, rowNumber, rowValues, r) {
  sheet.getRange(rowNumber, 9, 1, 5)
       .setValues([[r.theme, r.sentiment, r.urgency, r.summary, "Yes"]]);

  if (r.urgency === "High" && rowValues[14] !== "Yes") {
    sendUrgentAlert(sheet, rowNumber, rowValues, r);
    sheet.getRange(rowNumber, 15).setValue("Yes");  // prevents duplicate alerts
  }
}

// ===== URGENT HR EMAIL =====
function sendUrgentAlert(sheet, rowNumber, rowValues, r) {
  const hrEmail = PropertiesService.getScriptProperties().getProperty("HR_ALERT_EMAIL");
  if (!hrEmail) { Logger.log("⚠️ HR_ALERT_EMAIL not set. Alert not sent."); return; }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rowLink = ss.getUrl() + "#gid=" + sheet.getSheetId() + "&range=A" + rowNumber;

  const htmlBody = `
    <div style="font-family:Arial,sans-serif;max-width:600px">
      <h2 style="color:#c0392b">🚨 High Urgency Employee Feedback</h2>
      <p>A feedback response needs HR attention within <b>24 hours</b>.</p>
      <table style="border-collapse:collapse;width:100%">
        <tr><td style="padding:6px;border:1px solid #ddd"><b>Survey Type</b></td><td style="padding:6px;border:1px solid #ddd">${rowValues[1]}</td></tr>
        <tr><td style="padding:6px;border:1px solid #ddd"><b>Department</b></td><td style="padding:6px;border:1px solid #ddd">${rowValues[2]}</td></tr>
        <tr><td style="padding:6px;border:1px solid #ddd"><b>Tenure</b></td><td style="padding:6px;border:1px solid #ddd">${rowValues[3]}</td></tr>
        <tr><td style="padding:6px;border:1px solid #ddd"><b>Theme</b></td><td style="padding:6px;border:1px solid #ddd">${r.theme}</td></tr>
        <tr><td style="padding:6px;border:1px solid #ddd"><b>AI Summary</b></td><td style="padding:6px;border:1px solid #ddd">${r.summary}</td></tr>
      </table>
      <h3>Original Feedback</h3>
      <p style="background:#f8f8f8;padding:10px;border-left:4px solid #c0392b">
        ${rowValues[5]}<br><br>${rowValues[6]}<br><br>${rowValues[7] || ""}
      </p>
      <p><a href="${rowLink}">👉 Open this response in the sheet</a></p>
      <p style="color:#888;font-size:12px">This alert was generated by AI. Please review the original feedback before taking action.</p>
    </div>`;

  MailApp.sendEmail({
    to: hrEmail,
    subject: "🚨 High Urgency Feedback – " + rowValues[2] + " (" + rowValues[1] + ")",
    htmlBody: htmlBody
  });
  Logger.log("📧 Alert sent for row " + rowNumber);
}

// ===== AUTOMATION 1: Runs on every form submission =====
function handleFormSubmit(e) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log("🔒 Another process is running; the time trigger will pick this up."); return; }

  try {
    const sheet = getSheet();
    const rowNumber = e.range.getRow();
    const rowValues = sheet.getRange(rowNumber, 1, 1, TOTAL_COLUMNS).getValues()[0];

    try {
      const r = analyzeFeedback(getFeedbackText(rowValues));
      writeResult(sheet, rowNumber, rowValues, r);
      Logger.log("Row " + rowNumber + " ✅ " + r.theme + " | " + r.urgency);
    } catch (err) {
      sheet.getRange(rowNumber, 13).setValue("Error");
      Logger.log("Row " + rowNumber + " ❌ " + err.message + " (will be retried by time trigger)");
    }
  } finally {
    lock.releaseLock();
  }
}

// ===== AUTOMATION 2 + MANUAL: Process all pending rows in batches =====
function analyzeAllFeedback() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log("🔒 Another process is running. Will retry later."); return; }

  try {
    const sheet = getSheet();
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;

    const data = sheet.getRange(2, 1, lastRow - 1, TOTAL_COLUMNS).getValues();
    const pending = [];
    data.forEach((rowValues, i) => {
      if (rowValues[12] !== "Yes" && rowValues[5]) {
        pending.push({ id: String(i + 2), row: i + 2, values: rowValues, text: getFeedbackText(rowValues) });
      }
    });

    if (pending.length === 0) { Logger.log("✨ No pending rows."); return; }
    Logger.log("📋 Pending rows: " + pending.length);

    const startTime = Date.now();
    let done = 0, failed = 0;

    for (let b = 0; b < pending.length; b += BATCH_SIZE) {
      // Apps Script has a 6-minute limit; stop safely at 4.5 minutes
      if (Date.now() - startTime > 4.5 * 60 * 1000) {
        Logger.log("⏱️ Near time limit. Remaining rows will run next time.");
        break;
      }
      const batch = pending.slice(b, b + BATCH_SIZE);
      try {
        const results = analyzeBatch(batch);
        batch.forEach(item => {
          const r = results[item.id];
          if (r) { writeResult(sheet, item.row, item.values, r); done++; }
          else { sheet.getRange(item.row, 13).setValue("Error"); failed++; }
        });
      } catch (e) {
        batch.forEach(item => sheet.getRange(item.row, 13).setValue("Error"));
        failed += batch.length;
        Logger.log("❌ Batch failed: " + e.message);
      }
      Utilities.sleep(2000);
    }
    Logger.log("🏁 Done: " + done + " | Failed: " + failed);
  } finally {
    lock.releaseLock();
  }
}

// ===== SETUP: Create triggers (run once) =====
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));  // avoid duplicates

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ScriptApp.newTrigger("handleFormSubmit").forSpreadsheet(ss).onFormSubmit().create();
  ScriptApp.newTrigger("analyzeAllFeedback").timeBased().everyMinutes(15).create();

  Logger.log("✅ Triggers ready: form submit + retry every 15 min");
}

// ===== TEST: Send a sample alert for row 8 =====
function testAlert() {
  const sheet = getSheet();
  const rowValues = sheet.getRange(8, 1, 1, TOTAL_COLUMNS).getValues()[0];
  const r = { theme: rowValues[8], summary: rowValues[11] };
  sendUrgentAlert(sheet, 8, rowValues, r);
}

// ===== TEST: Check API connection =====
function testConnection() {
  Logger.log(callGemini("Reply in one line: Connection successful!"));
}
