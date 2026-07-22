-- Source attribution: which client wrote each entry (mcp | capture | web).
-- Lets agents/UI tell apart "logged from iPhone" vs "logged via Claude".
ALTER TABLE entries ADD COLUMN via TEXT NOT NULL DEFAULT 'unknown';
