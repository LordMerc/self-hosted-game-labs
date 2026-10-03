CREATE TABLE `port_checks` (
	`server_id` text NOT NULL,
	`port` integer NOT NULL,
	`protocol` text NOT NULL,
	`state` text NOT NULL,
	`detail` text NOT NULL,
	`checked_at` integer NOT NULL,
	`public_ip` text,
	PRIMARY KEY(`server_id`, `port`, `protocol`),
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
