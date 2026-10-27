-- =====================================================================
-- Terms accepted at booking time
-- Modules: portable-charger, pick-drop, road-assistance
-- =====================================================================
-- Stores one version of the terms bullets. Each booking keeps the
-- version id that was active when the user booked.
-- Active terms source: response_content
--   status = 1, response_type IS NULL, module_name in the three modules.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. terms_versions
-- ---------------------------------------------------------------------
CREATE TABLE `plusx-node`.`terms_versions` (
    `id`          INT UNSIGNED NOT NULL AUTO_INCREMENT,
    `module_name` VARCHAR(50) NOT NULL,
    `heading`     VARCHAR(500) NULL DEFAULT NULL,
    `content`     JSON NOT NULL,
    `version_no`  INT UNSIGNED NOT NULL,
    `status`      TINYINT NOT NULL DEFAULT 1,
    `created_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uq_terms_module_version` (`module_name`, `version_no`),
    KEY `idx_terms_module_status` (`module_name`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ---------------------------------------------------------------------
-- 2. Version 1 from the terms that are active now
-- ---------------------------------------------------------------------
SET SESSION group_concat_max_len = 1048576;

INSERT INTO `plusx-node`.`terms_versions` (`module_name`, `heading`, `content`, `version_no`, `status`, `created_at`)
SELECT
    c.module_name,
    m.heading,
    CONCAT('[', GROUP_CONCAT(JSON_QUOTE(c.content) ORDER BY c.id SEPARATOR ','), ']'),
    1,
    1,
    NOW()
FROM `plusx-node`.`response_content` c
LEFT JOIN `plusx-node`.`response_module` m
  ON m.name = c.module_name
 AND m.status = 1
 AND (m.sub_module IS NULL OR m.sub_module = '')
WHERE c.status = 1
  AND c.response_type IS NULL
  AND c.module_name IN ('portable-charger', 'pick-drop', 'road-assistance')
GROUP BY c.module_name, m.heading;


-- ---------------------------------------------------------------------
-- 3. Link columns on the three booking tables
-- ---------------------------------------------------------------------
ALTER TABLE `plusx-node`.`portable_charger_booking`
    ADD COLUMN `terms_version_id` INT UNSIGNED NULL DEFAULT NULL,
    ADD COLUMN `terms_accepted_at` DATETIME NULL DEFAULT NULL,
    ADD KEY `idx_pcb_terms_version` (`terms_version_id`);

ALTER TABLE `plusx-node`.`charging_service`
    ADD COLUMN `terms_version_id` INT UNSIGNED NULL DEFAULT NULL,
    ADD COLUMN `terms_accepted_at` DATETIME NULL DEFAULT NULL,
    ADD KEY `idx_cs_terms_version` (`terms_version_id`);

ALTER TABLE `plusx-node`.`road_assistance`
    ADD COLUMN `terms_version_id` INT UNSIGNED NULL DEFAULT NULL,
    ADD COLUMN `terms_accepted_at` DATETIME NULL DEFAULT NULL,
    ADD KEY `idx_ra_terms_version` (`terms_version_id`);


-- ---------------------------------------------------------------------
-- 4. Existing bookings use version 1 (the current terms)
-- ---------------------------------------------------------------------
UPDATE `plusx-node`.`portable_charger_booking` b
JOIN `plusx-node`.`terms_versions` t
  ON t.module_name = 'portable-charger'
 AND t.version_no = 1
SET b.terms_version_id = t.id,
    b.terms_accepted_at = b.created_at
WHERE b.terms_version_id IS NULL;

UPDATE `plusx-node`.`charging_service` b
JOIN `plusx-node`.`terms_versions` t
  ON t.module_name = 'pick-drop'
 AND t.version_no = 1
SET b.terms_version_id = t.id,
    b.terms_accepted_at = b.created_at
WHERE b.terms_version_id IS NULL;

UPDATE `plusx-node`.`road_assistance` b
JOIN `plusx-node`.`terms_versions` t
  ON t.module_name = 'road-assistance'
 AND t.version_no = 1
SET b.terms_version_id = t.id,
    b.terms_accepted_at = b.created_at
WHERE b.terms_version_id IS NULL;
