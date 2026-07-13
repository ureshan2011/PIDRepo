CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'open' NOT NULL,
	`options` text,
	`criteria` text,
	`recommendation` text,
	`confidence` real,
	`related_entity_ids` text,
	`related_item_ids` text,
	`decided_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `goals` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`category` text,
	`status` text DEFAULT 'active' NOT NULL,
	`target_date` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `habit_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`habit_id` text NOT NULL,
	`logged_at` integer NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	`note` text,
	FOREIGN KEY (`habit_id`) REFERENCES `habits`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `habit_logs_habit_logged_idx` ON `habit_logs` (`habit_id`,`logged_at`);--> statement-breakpoint
CREATE TABLE `habits` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`cadence` text NOT NULL,
	`cadence_rule` text,
	`target_count` integer DEFAULT 1 NOT NULL,
	`unit` text,
	`goal_id` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `insights` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`confidence` real,
	`related_entity_ids` text,
	`related_item_ids` text,
	`status` text DEFAULT 'new' NOT NULL,
	`generated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `insights_status_generated_idx` ON `insights` (`status`,`generated_at`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`payload` text,
	`priority` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`run_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jobs_status_run_at_idx` ON `jobs` (`status`,`run_at`);--> statement-breakpoint
CREATE TABLE `journal_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_date` integer NOT NULL,
	`prompt` text,
	`content` text,
	`mood` text,
	`tags` text,
	`linked_item_ids` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `journal_entry_date_idx` ON `journal_entries` (`entry_date`);--> statement-breakpoint
CREATE TABLE `message_identity` (
	`message_id` text PRIMARY KEY NOT NULL,
	`canonical_item_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`first_seen_tap` text NOT NULL,
	`first_seen_source_id` text,
	`seen_taps` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`canonical_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`first_seen_source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `message_identity_canonical_idx` ON `message_identity` (`canonical_item_id`);--> statement-breakpoint
CREATE INDEX `message_identity_content_hash_idx` ON `message_identity` (`content_hash`);--> statement-breakpoint
CREATE TABLE `milestones` (
	`id` text PRIMARY KEY NOT NULL,
	`goal_id` text NOT NULL,
	`title` text NOT NULL,
	`target_date` integer,
	`completed_at` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `milestones_goal_idx` ON `milestones` (`goal_id`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`period_type` text NOT NULL,
	`period_start` integer NOT NULL,
	`period_end` integer NOT NULL,
	`summary` text,
	`highlights` text,
	`generated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_period_uq` ON `reviews` (`period_type`,`period_start`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_state` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` text NOT NULL,
	`resource` text NOT NULL,
	`tap` text NOT NULL,
	`direction` text DEFAULT 'incremental' NOT NULL,
	`cursor_type` text,
	`cursor_value` text,
	`status` text DEFAULT 'ok' NOT NULL,
	`status_reason` text,
	`last_attempt_at` integer,
	`last_success_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_state_resource_tap_direction_uq` ON `sync_state` (`source_id`,`resource`,`tap`,`direction`);--> statement-breakpoint
CREATE TABLE `chunks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`content` text NOT NULL,
	`token_count` integer,
	`char_start` integer,
	`char_end` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chunks_item_chunk_uq` ON `chunks` (`item_id`,`chunk_index`);--> statement-breakpoint
CREATE TABLE `embedding_meta` (
	`chunk_id` integer PRIMARY KEY NOT NULL,
	`model_name` text NOT NULL,
	`dims` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`chunk_id`) REFERENCES `chunks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `item_external_ids` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` text NOT NULL,
	`source_id` text NOT NULL,
	`tap` text NOT NULL,
	`external_id` text NOT NULL,
	`raw_identifiers` text,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `item_ext_ids_source_tap_external_uq` ON `item_external_ids` (`source_id`,`tap`,`external_id`);--> statement-breakpoint
CREATE INDEX `item_ext_ids_item_idx` ON `item_external_ids` (`item_id`);--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`source_id` text NOT NULL,
	`external_id` text NOT NULL,
	`title` text,
	`body` text,
	`body_format` text DEFAULT 'text' NOT NULL,
	`url` text,
	`occurred_at` integer,
	`content_hash` text,
	`metadata` text,
	`is_deleted` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ingested_at` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `items_source_external_uq` ON `items` (`source_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `items_type_idx` ON `items` (`type`);--> statement-breakpoint
CREATE INDEX `items_occurred_at_idx` ON `items` (`occurred_at`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_id` text NOT NULL,
	`account_id` text NOT NULL,
	`display_name` text NOT NULL,
	`category` text NOT NULL,
	`config` text,
	`enabled` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'ok' NOT NULL,
	`status_reason` text,
	`last_sync_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sources_connector_account_uq` ON `sources` (`connector_id`,`account_id`);--> statement-breakpoint
CREATE TABLE `ai_conversation_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_item_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`token_count` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_item_id`) REFERENCES `ai_conversations`(`item_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ai_conv_messages_conv_idx` ON `ai_conversation_messages` (`conversation_item_id`);--> statement-breakpoint
CREATE TABLE `ai_conversations` (
	`item_id` text PRIMARY KEY NOT NULL,
	`model_name` text,
	`started_at` integer,
	`ended_at` integer,
	`message_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `bookmarks` (
	`item_id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`folder_path` text,
	`favicon_url` text,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `contacts` (
	`item_id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`emails` text,
	`phones` text,
	`company` text,
	`entity_id` text,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `documents` (
	`item_id` text PRIMARY KEY NOT NULL,
	`file_path` text,
	`mime_type` text,
	`file_size_bytes` integer,
	`page_count` integer,
	`checksum` text,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `emails` (
	`item_id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`thread_id` text,
	`from_address` text,
	`from_name` text,
	`to_addresses` text,
	`cc_addresses` text,
	`folder` text,
	`is_read` integer DEFAULT false NOT NULL,
	`has_attachments` integer DEFAULT false NOT NULL,
	`importance` text,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `emails_message_id_idx` ON `emails` (`message_id`);--> statement-breakpoint
CREATE INDEX `emails_thread_id_idx` ON `emails` (`thread_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`item_id` text PRIMARY KEY NOT NULL,
	`start_at` integer NOT NULL,
	`end_at` integer,
	`all_day` integer DEFAULT false NOT NULL,
	`location` text,
	`organizer_email` text,
	`attendees` text,
	`status` text,
	`response_status` text,
	`recurrence_rule` text,
	`recurrence_master_item_id` text,
	`calendar_uid` text,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recurrence_master_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `events_start_at_idx` ON `events` (`start_at`);--> statement-breakpoint
CREATE INDEX `events_master_idx` ON `events` (`recurrence_master_item_id`);--> statement-breakpoint
CREATE TABLE `feed_items` (
	`item_id` text PRIMARY KEY NOT NULL,
	`feed_id` text NOT NULL,
	`url` text,
	`published_at` integer,
	`author` text,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`feed_id`) REFERENCES `feeds`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `feed_items_feed_idx` ON `feed_items` (`feed_id`);--> statement-breakpoint
CREATE TABLE `feeds` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`url` text NOT NULL,
	`title` text,
	`site_url` text,
	`etag` text,
	`last_modified` text,
	`poll_interval_minutes` integer DEFAULT 60 NOT NULL,
	`last_polled_at` integer,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `health_metrics` (
	`item_id` text PRIMARY KEY NOT NULL,
	`metric_type` text NOT NULL,
	`value` real NOT NULL,
	`unit` text,
	`recorded_at` integer NOT NULL,
	`source_device` text,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `health_metrics_type_recorded_idx` ON `health_metrics` (`metric_type`,`recorded_at`);--> statement-breakpoint
CREATE TABLE `notes` (
	`item_id` text PRIMARY KEY NOT NULL,
	`notebook` text,
	`tags` text,
	`pinned` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `papers` (
	`item_id` text PRIMARY KEY NOT NULL,
	`authors` text,
	`venue` text,
	`year` integer,
	`doi` text,
	`arxiv_id` text,
	`citation_count` integer,
	`abstract` text,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `papers_doi_idx` ON `papers` (`doi`);--> statement-breakpoint
CREATE TABLE `photos_index` (
	`item_id` text PRIMARY KEY NOT NULL,
	`file_path` text NOT NULL,
	`taken_at` integer,
	`gps_lat` real,
	`gps_lon` real,
	`camera_model` text,
	`width` integer,
	`height` integer,
	`perceptual_hash` text,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `photos_taken_at_idx` ON `photos_index` (`taken_at`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`item_id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`priority` text,
	`due_at` integer,
	`completed_at` integer,
	`project` text,
	`recurrence_rule` text,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tasks_due_status_idx` ON `tasks` (`due_at`,`status`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`item_id` text PRIMARY KEY NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`account` text,
	`category` text,
	`merchant` text,
	`transaction_date` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `transactions_date_idx` ON `transactions` (`transaction_date`);--> statement-breakpoint
CREATE INDEX `transactions_category_idx` ON `transactions` (`category`);--> statement-breakpoint
CREATE TABLE `trip_segments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trip_item_id` text NOT NULL,
	`segment_type` text NOT NULL,
	`start_at` integer,
	`end_at` integer,
	`confirmation_code` text,
	`details` text,
	FOREIGN KEY (`trip_item_id`) REFERENCES `trips`(`item_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `trip_segments_trip_idx` ON `trip_segments` (`trip_item_id`);--> statement-breakpoint
CREATE TABLE `trips` (
	`item_id` text PRIMARY KEY NOT NULL,
	`destination` text,
	`start_date` integer,
	`end_date` integer,
	`status` text,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `edges` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`src_kind` text NOT NULL,
	`src_id` text NOT NULL,
	`dst_kind` text NOT NULL,
	`dst_id` text NOT NULL,
	`relation` text NOT NULL,
	`weight` real DEFAULT 1 NOT NULL,
	`confidence` real DEFAULT 1 NOT NULL,
	`method` text NOT NULL,
	`primary_source_item_id` text,
	`provenance` text,
	`attributes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`primary_source_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `edges_src_idx` ON `edges` (`src_kind`,`src_id`);--> statement-breakpoint
CREATE INDEX `edges_dst_idx` ON `edges` (`dst_kind`,`dst_id`);--> statement-breakpoint
CREATE INDEX `edges_relation_idx` ON `edges` (`relation`);--> statement-breakpoint
CREATE TABLE `entities` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`aliases` text,
	`description` text,
	`attributes` text,
	`canonical_entity_id` text,
	`confidence` real DEFAULT 1 NOT NULL,
	`mention_count` integer DEFAULT 0 NOT NULL,
	`provenance` text,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`canonical_entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `entities_type_name_idx` ON `entities` (`type`,`name`);--> statement-breakpoint
CREATE INDEX `entities_canonical_idx` ON `entities` (`canonical_entity_id`);--> statement-breakpoint
CREATE TABLE `entity_embedding_meta` (
	`entity_id` text PRIMARY KEY NOT NULL,
	`model_name` text NOT NULL,
	`dims` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade
);
