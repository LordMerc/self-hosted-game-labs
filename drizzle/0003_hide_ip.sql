ALTER TABLE `servers` ADD `hide_ip` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `servers` SET `hide_ip` = 1, `access` = 'private' WHERE `access` = 'relay';
