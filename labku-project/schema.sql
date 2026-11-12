-- Jalankan SEKALI di Neon > SQL Editor
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('ADMIN','STAFF')),
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS items (
  id       SERIAL PRIMARY KEY,
  code     TEXT UNIQUE NOT NULL,
  name     TEXT NOT NULL,
  category TEXT,
  total    INT NOT NULL CHECK (total >= 0)
);

CREATE TABLE IF NOT EXISTS loans (
  id          SERIAL PRIMARY KEY,
  borrower    TEXT NOT NULL,
  item_id     INT NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  qty         INT NOT NULL CHECK (qty > 0),
  loan_date   DATE NOT NULL,
  return_date DATE,
  status      TEXT NOT NULL DEFAULT 'DIPINJAM' CHECK (status IN ('DIPINJAM','SELESAI')),
  staff_id    INT NOT NULL REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS loans_status_idx ON loans(status);
CREATE INDEX IF NOT EXISTS loans_item_idx   ON loans(item_id);

-- Akun awal (password: admin123 dan staff123). Segera ganti lewat menu Pengguna.
INSERT INTO users (username, name, password_hash, role) VALUES
  ('admin', 'Administrator', crypt('admin123', gen_salt('bf', 10)), 'ADMIN'),
  ('staff', 'Petugas Lab',   crypt('staff123', gen_salt('bf', 10)), 'STAFF')
ON CONFLICT (username) DO NOTHING;

-- Contoh barang (boleh dihapus/diubah dari aplikasi)
INSERT INTO items (code, name, category, total) VALUES
  ('MIK-01', 'Mikroskop Binokuler', 'Alat optik', 5),
  ('GLS-01', 'Gelas Ukur 100 ml',   'Gelas',      12),
  ('TMT-01', 'Termometer Digital',  'Pengukur',   6),
  ('NRC-01', 'Neraca Analitik',     'Pengukur',   2)
ON CONFLICT (code) DO NOTHING;
