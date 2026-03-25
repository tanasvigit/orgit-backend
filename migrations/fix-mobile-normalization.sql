-- Fix mobile numbers that were incorrectly normalized (e.g., +9191949024246 should be +919949024246)
-- This fixes mobiles that have 13+ digits (likely double-prefixed with +91)

-- Step 1: Fix mobiles with 13 digits starting with +9191 (e.g., +9191949024246 → +919949024246)
UPDATE users
SET mobile = '+91' || SUBSTRING(REPLACE(mobile, ' ', '') FROM 5)
WHERE LENGTH(REPLACE(mobile, ' ', '')) = 13 
  AND REPLACE(mobile, ' ', '') LIKE '+9191%';

-- Step 2: Fix mobiles with 14+ digits starting with +9191 (remove duplicate 91)
UPDATE users
SET mobile = '+91' || SUBSTRING(REPLACE(mobile, ' ', '') FROM 5)
WHERE LENGTH(REPLACE(mobile, ' ', '')) >= 14 
  AND REPLACE(mobile, ' ', '') LIKE '+9191%';

-- Step 3: Normalize mobiles without + prefix (10 digits → +91XXXXXXXXXX, 12 digits starting with 91 → +919XXXXXXXXX)
UPDATE users
SET mobile = CASE
  WHEN LENGTH(REPLACE(mobile, ' ', '')) = 10 THEN '+91' || REPLACE(mobile, ' ', '')
  WHEN LENGTH(REPLACE(mobile, ' ', '')) = 12 AND REPLACE(mobile, ' ', '') LIKE '91%' THEN '+' || REPLACE(mobile, ' ', '')
  ELSE mobile
END
WHERE mobile NOT LIKE '+%' 
  AND (LENGTH(REPLACE(mobile, ' ', '')) = 10 OR (LENGTH(REPLACE(mobile, ' ', '')) = 12 AND REPLACE(mobile, ' ', '') LIKE '91%'));
