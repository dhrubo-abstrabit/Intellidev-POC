// Minimal hand-built single-page PDF containing the text "Hello PDF" — small
// enough to inline rather than adding a binary-fixture convention this
// codebase doesn't otherwise have. Verified locally to parse before relying
// on it in tests. Encode with Buffer.from(MINIMAL_PDF, "latin1") — the stream
// length below is byte-exact for that encoding, not utf8.
export const MINIMAL_PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj
4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
5 0 obj<</Length 44>>stream
BT /F1 24 Tf 10 40 Td (Hello PDF) Tj ET
endstream
endobj
trailer<</Size 6/Root 1 0 R>>
%%EOF`;

// Same shape as MINIMAL_PDF, but with page text over parse.ts's
// MIN_PAGE_CHARS (30) floor — MINIMAL_PDF's "Hello PDF" is deliberately
// short for load.test.ts's outage guard, which only needs SOME extractable
// text, but that shortness makes it a divider-page false negative for
// anything exercising per-page chunk-worthiness.
export const MINIMAL_PDF_LONG_TEXT = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 100]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj
4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
5 0 obj<</Length 106>>stream
BT /F1 24 Tf 10 40 Td (This is a longer paragraph of sample text used for page-level parsing tests.) Tj ET
endstream
endobj
trailer<</Size 6/Root 1 0 R>>
%%EOF`;
