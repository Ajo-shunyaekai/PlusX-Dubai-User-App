-- =====================================================================
-- New-user home welcome popup copy (CMS)
-- Backend sends this on GET /rider-home as new_user_popup; app decides when to show.
-- =====================================================================

INSERT INTO `response_content` (`module_name`, `response_type`, `content`, `status`)
SELECT 'home', 'new-user-welcome', '10% OFF Roadside Assistance!', 1
WHERE NOT EXISTS (
    SELECT 1 FROM `response_content`
    WHERE `module_name` = 'home' AND `response_type` = 'new-user-welcome'
      AND `content` = '10% OFF Roadside Assistance!'
);

INSERT INTO `response_content` (`module_name`, `response_type`, `content`, `status`)
SELECT 'home', 'new-user-welcome', 'Book Roadside Assistance & get 10% OFF with code RSA10%OFF.', 1
WHERE NOT EXISTS (
    SELECT 1 FROM `response_content`
    WHERE `module_name` = 'home' AND `response_type` = 'new-user-welcome'
      AND `content` = 'Book Roadside Assistance & get 10% OFF with code RSA10%OFF.'
);