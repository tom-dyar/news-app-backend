-- News articles collected per topic. Dates are ISO 8601 UTC text (SQLite has no date type).
CREATE TABLE articles (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  topic            TEXT    NOT NULL,
  headline         TEXT    NOT NULL,
  source           TEXT    NOT NULL,
  published_at     TEXT    NOT NULL,
  url              TEXT    NOT NULL UNIQUE,
  summary          TEXT,
  relevance_score  INTEGER CHECK (relevance_score IS NULL OR relevance_score BETWEEN 1 AND 10),
  fetched_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_articles_topic_published ON articles (topic, published_at DESC);
CREATE INDEX idx_articles_relevance ON articles (relevance_score DESC);
