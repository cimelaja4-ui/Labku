// Backend LabKu: satu fungsi serverless Vercel yang melayani semua /api/*
const { neon } = require('@neondatabase/serverless');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

let sql;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, msg) => new HttpError(status, msg);
const str = (v, max = 100) => String(v ?? '').trim().slice(0, max);
const int = (v) => (/^-?\d+$/.test(String(v ?? '').trim()) ? Number(v) : NaN);

async function auth(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  let p;
  try { p = jwt.verify(token, process.env.JWT_SECRET); }
  catch { throw fail(401, 'Sesi habis, silakan login lagi'); }
  const [u] = await sql`SELECT id, username, name, role, active FROM users WHERE id = ${p.id}`;
  if (!u || !u.active) throw fail(401, 'Akun tidak aktif atau tidak ditemukan');
  return u;
}

function itemInput(b) {
  const code = str(b.code, 30), name = str(b.name, 120);
  const category = str(b.category, 60) || null, total = int(b.total);
  if (!code || !name) throw fail(400, 'Kode dan nama wajib diisi');
  if (!(total >= 0)) throw fail(400, 'Total stok harus angka 0 atau lebih');
  return { code, name, category, total };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!process.env.DATABASE_URL || !process.env.JWT_SECRET)
      throw fail(500, 'Server belum dikonfigurasi: isi DATABASE_URL dan JWT_SECRET di Vercel');
    sql = sql || neon(process.env.DATABASE_URL);

    const url = new URL(req.url, 'http://localhost');
    const [a, b, c] = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    const m = req.method;
    let body = req.body || {};
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const ok = (data, status = 200) => res.status(status).json(data);

    // ---- LOGIN (tanpa token) ----
    if (a === 'login' && m === 'POST') {
      const username = str(body.username, 50).toLowerCase();
      const [u] = await sql`SELECT * FROM users WHERE username = ${username}`;
      const valid = u && bcrypt.compareSync(String(body.password ?? ''), u.password_hash);
      if (!valid) throw fail(401, 'Username atau password salah');
      if (!u.active) throw fail(401, 'Akun ini dinonaktifkan, hubungi Admin');
      const token = jwt.sign({ id: u.id }, process.env.JWT_SECRET, { expiresIn: '12h' });
      return ok({ token, user: { id: u.id, username: u.username, name: u.name, role: u.role } });
    }

    // ---- Semua route di bawah ini wajib login ----
    const u = await auth(req);
    const admin = () => { if (u.role !== 'ADMIN') throw fail(403, 'Hanya Admin yang boleh melakukan ini'); };
    const own = u.role === 'ADMIN' ? null : u.id; // Staff hanya melihat transaksinya sendiri
    const id = int(b);

    // DASHBOARD
    if (a === 'dashboard' && m === 'GET') {
      const [d] = await sql`SELECT
        (SELECT COALESCE(SUM(total), 0) FROM items)::int AS total,
        (SELECT COALESCE(SUM(qty), 0) FROM loans WHERE status = 'DIPINJAM')::int AS dipinjam,
        (SELECT COUNT(*) FROM loans)::int AS transaksi`;
      return ok({ total: d.total, tersedia: d.total - d.dipinjam, dipinjam: d.dipinjam, transaksi: d.transaksi });
    }

    // BARANG
    if (a === 'items') {
      if (!b && m === 'GET') {
        const q = '%' + str(url.searchParams.get('q'), 60).replace(/[\\%_]/g, '\\$&') + '%';
        return ok(await sql`SELECT i.id, i.code, i.name, i.category, i.total,
          (i.total - COALESCE((SELECT SUM(l.qty) FROM loans l WHERE l.item_id = i.id AND l.status = 'DIPINJAM'), 0))::int AS stock
          FROM items i
          WHERE i.code ILIKE ${q} OR i.name ILIKE ${q} OR COALESCE(i.category, '') ILIKE ${q}
          ORDER BY i.code`);
      }
      if (!b && m === 'POST') {
        admin();
        const it = itemInput(body);
        const [r] = await sql`INSERT INTO items (code, name, category, total)
          VALUES (${it.code}, ${it.name}, ${it.category}, ${it.total}) RETURNING id`;
        return ok({ id: r.id }, 201);
      }
      if (b && m === 'PUT') {
        admin();
        const it = itemInput(body);
        const [r] = await sql`SELECT COALESCE(SUM(qty), 0)::int AS dipinjam FROM loans WHERE item_id = ${id} AND status = 'DIPINJAM'`;
        if (it.total < r.dipinjam) throw fail(400, `Total stok tidak boleh di bawah jumlah yang sedang dipinjam (${r.dipinjam})`);
        const upd = await sql`UPDATE items SET code = ${it.code}, name = ${it.name}, category = ${it.category}, total = ${it.total}
          WHERE id = ${id} RETURNING id`;
        if (!upd.length) throw fail(404, 'Barang tidak ditemukan');
        return ok({ ok: true });
      }
      if (b && m === 'DELETE') {
        admin();
        const del = await sql`DELETE FROM items WHERE id = ${id} RETURNING id`;
        if (!del.length) throw fail(404, 'Barang tidak ditemukan');
        return ok({ ok: true });
      }
    }

    // PEMINJAMAN & PENGEMBALIAN
    if (a === 'loans') {
      if (!b && m === 'GET') {
        const s = url.searchParams.get('status');
        const status = s === 'DIPINJAM' || s === 'SELESAI' ? s : null;
        return ok(await sql`SELECT l.id, to_char(l.loan_date, 'YYYY-MM-DD') AS loan_date, l.borrower,
            i.code, i.name AS item, l.qty, l.status,
            to_char(l.return_date, 'YYYY-MM-DD') AS return_date, s.name AS staff
          FROM loans l JOIN items i ON i.id = l.item_id JOIN users s ON s.id = l.staff_id
          WHERE (${status}::text IS NULL OR l.status = ${status}::text)
            AND (${own}::int IS NULL OR l.staff_id = ${own}::int)
          ORDER BY l.loan_date DESC, l.id DESC`);
      }
      if (!b && m === 'POST') {
        const borrower = str(body.borrower, 100), itemId = int(body.item_id), qty = int(body.qty);
        const date = str(body.loan_date, 10);
        if (!borrower) throw fail(400, 'Nama peminjam wajib diisi');
        if (!Number.isInteger(itemId)) throw fail(400, 'Barang tidak valid');
        if (!(qty >= 1)) throw fail(400, 'Jumlah minimal 1');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw fail(400, 'Tanggal pinjam tidak valid');
        const r = await sql`INSERT INTO loans (borrower, item_id, qty, loan_date, staff_id)
          SELECT ${borrower}::text, i.id, ${qty}::int, ${date}::date, ${u.id}::int
          FROM items i
          WHERE i.id = ${itemId}::int
            AND i.total - COALESCE((SELECT SUM(l.qty) FROM loans l WHERE l.item_id = i.id AND l.status = 'DIPINJAM'), 0) >= ${qty}::int
          RETURNING id`;
        if (!r.length) throw fail(400, 'Stok tidak cukup atau barang tidak ditemukan');
        return ok({ id: r[0].id }, 201);
      }
      if (b && c === 'return' && m === 'POST') {
        const r = await sql`UPDATE loans SET status = 'SELESAI', return_date = (NOW() AT TIME ZONE 'Asia/Jakarta')::date
          WHERE id = ${id} AND status = 'DIPINJAM' AND (${own}::int IS NULL OR staff_id = ${own}::int)
          RETURNING id`;
        if (!r.length) throw fail(404, 'Transaksi tidak ditemukan atau sudah dikembalikan');
        return ok({ ok: true });
      }
    }

    // PENGGUNA (khusus Admin)
    if (a === 'users') {
      admin();
      if (!b && m === 'GET')
        return ok(await sql`SELECT id, username, name, role, active FROM users ORDER BY role, username`);
      if (!b && m === 'POST') {
        const username = str(body.username, 30).toLowerCase(), name = str(body.name, 100), pw = String(body.password ?? '');
        if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw fail(400, 'Username 3-30 karakter: huruf kecil, angka, titik, strip');
        if (!name) throw fail(400, 'Nama lengkap wajib diisi');
        if (pw.length < 6) throw fail(400, 'Password minimal 6 karakter');
        const [r] = await sql`INSERT INTO users (username, name, password_hash, role)
          VALUES (${username}, ${name}, ${bcrypt.hashSync(pw, 10)}, 'STAFF') RETURNING id`;
        return ok({ id: r.id }, 201);
      }
      if (b && m === 'PUT') {
        const name = str(body.name, 100), pw = String(body.password ?? '');
        const active = body.active !== false;
        if (!name) throw fail(400, 'Nama lengkap wajib diisi');
        if (pw && pw.length < 6) throw fail(400, 'Password baru minimal 6 karakter');
        const [t] = await sql`SELECT role FROM users WHERE id = ${id}`;
        if (!t) throw fail(404, 'Pengguna tidak ditemukan');
        if (t.role === 'ADMIN' && !active) throw fail(400, 'Akun Admin tidak bisa dinonaktifkan');
        const hash = pw ? bcrypt.hashSync(pw, 10) : null;
        await sql`UPDATE users SET name = ${name}, active = ${active},
          password_hash = COALESCE(${hash}::text, password_hash) WHERE id = ${id}`;
        return ok({ ok: true });
      }
    }

    throw fail(404, 'Endpoint tidak ditemukan');
  } catch (e) {
    let status = e.status || 500, msg = e.message;
    if (e.code === '23505') { status = 409; msg = 'Kode atau username itu sudah dipakai'; }
    else if (e.code === '23503') { status = 409; msg = 'Data ini masih dipakai di riwayat peminjaman, jadi tidak bisa dihapus'; }
    else if (!e.status) { console.error(e); msg = 'Terjadi kesalahan pada server'; }
    res.status(status).json({ error: msg });
  }
};
