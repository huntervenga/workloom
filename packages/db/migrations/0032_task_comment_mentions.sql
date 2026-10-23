-- People @mentioned in a comment; the inbox lists a mention for the person it names.
CREATE TABLE "task_comment_mentions" (
  "workspace_id" uuid NOT NULL,
  "comment_id" uuid NOT NULL,
  "membership_id" uuid NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "task_comment_mentions_pkey" PRIMARY KEY ("comment_id", "membership_id"),
  CONSTRAINT "task_comment_mentions_comment_fk" FOREIGN KEY ("comment_id") REFERENCES "task_comments" ("id"),
  CONSTRAINT "task_comment_mentions_membership_fk" FOREIGN KEY ("workspace_id", "membership_id") REFERENCES "memberships" ("workspace_id", "id")
);
CREATE INDEX "task_comment_mentions_person_idx" ON "task_comment_mentions" ("workspace_id", "membership_id", "created_at" DESC);
