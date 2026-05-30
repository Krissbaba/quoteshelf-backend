import { query } from './pool.js';
import dotenv from 'dotenv';
dotenv.config();

const schema = `
-- Users
CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username    VARCHAR(50) UNIQUE NOT NULL,
  email       VARCHAR(255) UNIQUE NOT NULL,
  password    VARCHAR(255) NOT NULL,
  display_name VARCHAR(100),
  bio         TEXT,
  avatar_url  TEXT,
  is_public   BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Source books (the real books quotes come from)
CREATE TABLE IF NOT EXISTS sources (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       VARCHAR(500) NOT NULL,
  author      VARCHAR(500),
  publisher   VARCHAR(300),
  year        INTEGER,
  isbn        VARCHAR(20),
  genre       VARCHAR(100),
  type        VARCHAR(50) DEFAULT 'book',
  cover_url   TEXT,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  search_vec  TSVECTOR
);

-- Quotes
CREATE TABLE IF NOT EXISTS quotes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id    UUID REFERENCES sources(id) ON DELETE SET NULL,
  text         TEXT NOT NULL,
  page_number  INTEGER,
  line_number  INTEGER,
  chapter      VARCHAR(200),
  context      TEXT,
  tags         TEXT[],
  is_public    BOOLEAN DEFAULT true,
  likes_count  INTEGER DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  search_vec   TSVECTOR
);

-- Custom books (curated collections by users)
CREATE TABLE IF NOT EXISTS books (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        VARCHAR(300) NOT NULL,
  description  TEXT,
  cover_color  VARCHAR(7) DEFAULT '#F5F0EB',
  is_public    BOOLEAN DEFAULT true,
  clones_count INTEGER DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Quotes in custom books (many-to-many)
CREATE TABLE IF NOT EXISTS book_quotes (
  book_id      UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  quote_id     UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  position     INTEGER DEFAULT 0,
  added_at     TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (book_id, quote_id)
);

-- Likes
CREATE TABLE IF NOT EXISTS likes (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  quote_id     UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, quote_id)
);

-- Follows
CREATE TABLE IF NOT EXISTS follows (
  follower_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (follower_id, following_id),
  CHECK (follower_id != following_id)
);

-- Saved quotes (bookmarked by other users)
CREATE TABLE IF NOT EXISTS saved_quotes (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  quote_id     UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, quote_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_quotes_user_id ON quotes(user_id);
CREATE INDEX IF NOT EXISTS idx_quotes_source_id ON quotes(source_id);
CREATE INDEX IF NOT EXISTS idx_quotes_created_at ON quotes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quotes_tags ON quotes USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_book_quotes_book ON book_quotes(book_id, position);
CREATE INDEX IF NOT EXISTS idx_likes_quote ON likes(quote_id);

-- Search vector trigger for quotes
CREATE OR REPLACE FUNCTION quotes_search_vec_update()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vec = to_tsvector('english',
    coalesce(NEW.text, '') || ' ' ||
    coalesce(NEW.context, '') || ' ' ||
    coalesce(array_to_string(NEW.tags, ' '), '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_quotes_search_vec ON quotes;
CREATE TRIGGER trg_quotes_search_vec
  BEFORE INSERT OR UPDATE ON quotes
  FOR EACH ROW EXECUTE FUNCTION quotes_search_vec_update();

-- Search vector trigger for sources
CREATE OR REPLACE FUNCTION sources_search_vec_update()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vec = to_tsvector('english',
    coalesce(NEW.title, '') || ' ' ||
    coalesce(NEW.author, '') || ' ' ||
    coalesce(NEW.genre, '') || ' ' ||
    coalesce(NEW.type, '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sources_search_vec ON sources;
CREATE TRIGGER trg_sources_search_vec
  BEFORE INSERT OR UPDATE ON sources
  FOR EACH ROW EXECUTE FUNCTION sources_search_vec_update();

-- GIN indexes for full-text search (after triggers exist)
CREATE INDEX IF NOT EXISTS idx_quotes_search ON quotes USING GIN(search_vec);
CREATE INDEX IF NOT EXISTS idx_sources_search ON sources USING GIN(search_vec);

-- Updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger to relevant tables
DROP TRIGGER IF EXISTS trg_users_updated ON users;
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_quotes_updated ON quotes;
CREATE TRIGGER trg_quotes_updated BEFORE UPDATE ON quotes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_books_updated ON books;
CREATE TRIGGER trg_books_updated BEFORE UPDATE ON books
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
`;

async function setup() {
  try {
    console.log('🗄️  Setting up QuoteShelf database...');
    await query(schema);
    console.log('✅  Schema created successfully!');
    console.log('');
    console.log('Tables created:');
    console.log('  • users');
    console.log('  • sources  (real books, articles, poems)');
    console.log('  • quotes   (with full-text search)');
    console.log('  • books    (custom curated collections)');
    console.log('  • book_quotes');
    console.log('  • likes, follows, saved_quotes');
    process.exit(0);
  } catch (err) {
    console.error('❌  Database setup failed:', err.message);
    process.exit(1);
  }
}

setup();
