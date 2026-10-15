-- A whole-history deletion invalidates conversation creations started before it.
ALTER TABLE browsers ADD COLUMN conversation_epoch INTEGER NOT NULL DEFAULT 0 CHECK (conversation_epoch >= 0);
