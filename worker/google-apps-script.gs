// Paste this into Extensions > Apps Script on the Google Sheet you want logs written to,
// then Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).
// The deployment URL becomes SHEETS_WEBHOOK_URL in the Worker's wrangler.toml.
//
// SECRET must match the Worker's SHEETS_SECRET (set via `wrangler secret put SHEETS_SECRET`) —
// it's the only thing stopping a random person who finds this URL from writing junk rows.
const SECRET = "eA9gBPiM8tYPrvZjzQnc7hRw4OMbxQ1c";

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    if (data.secret !== SECRET) {
      return ContentService.createTextOutput(JSON.stringify({ error: "unauthorized" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    sheet.appendRow([
      new Date(data.timestamp || Date.now()),
      data.destination || "",
      data.days || "",
      data.companions || "",
      data.budget || "",
      data.interests || "",
      data.resultTitle || "",
    ]);

    return ContentService.createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// Diagnostic only: GET .../exec?secret=... returns the row count and last row so you can
// verify writes are landing without opening the spreadsheet. Safe to remove later.
function doGet(e) {
  if (e.parameter.secret !== SECRET) {
    return ContentService.createTextOutput(JSON.stringify({ error: "unauthorized" }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const lastRow = sheet.getLastRow();
  const lastRowValues = lastRow > 0 ? sheet.getRange(lastRow, 1, 1, sheet.getLastColumn()).getValues()[0] : [];
  return ContentService.createTextOutput(JSON.stringify({ lastRow, lastRowValues }))
    .setMimeType(ContentService.MimeType.JSON);
}
