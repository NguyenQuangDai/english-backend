require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const Groq = require('groq-sdk');

const app = express();
app.use(cors());
app.use(express.json());

// Khởi tạo Supabase & Groq API
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const upload = multer({ storage: multer.memoryStorage() });

// ==========================================
// 1. MIDDLEWARE XÁC THỰC TOKEN & PHÂN QUYỀN
// ==========================================

// Kiểm tra Token người dùng gửi lên
async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Vui lòng đăng nhập để thực hiện' });
  }

  // Xác minh Token với Supabase Auth
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    return res.status(403).json({ error: 'Phiên đăng nhập hết hạn hoặc không hợp lệ' });
  }

  // Lấy vai trò (Role) từ bảng profiles
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  req.user = user;
  req.userRole = profile ? profile.role : 'user';
  next();
}

// Kiểm tra quyền Admin
function requireAdmin(req, res, next) {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ error: 'Từ chối truy cập! Thao tác này chỉ dành cho Admin.' });
  }
  next();
}

// ==========================================
// 2. API ĐĂNG KÝ / ĐĂNG NHẬP
// ==========================================

// API Đăng ký tài khoản
app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Vui lòng nhập Email và Mật khẩu' });

  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) return res.status(400).json({ error: error.message });

  if (data.user) {
    // Tự động gán quyền 'user' vào bảng profiles
    await supabase.from('profiles').insert([{ id: data.user.id, email: data.user.email, role: 'user' }]);
  }

  res.json({ message: 'Đăng ký thành công!', user: data.user });
});

// API Đăng nhập
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Vui lòng nhập Email và Mật khẩu' });

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(400).json({ error: 'Email hoặc mật khẩu không chính xác' });

  // Lấy role của tài khoản
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', data.user.id)
    .single();

  res.json({
    message: 'Đăng nhập thành công',
    token: data.session.access_token,
    role: profile ? profile.role : 'user',
    email: data.user.email
  });
});

// ==========================================
// 3. API QUẢN LÝ TỪ VỰNG & PHÁT ÂM
// ==========================================

// Lấy danh sách từ vựng (Ai cũng dùng được)
app.get('/api/words', async (req, res) => {
  const { data, error } = await supabase.from('words').select('*');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Thêm từ vựng mới (CHỈ ADMIN)
app.post('/api/words', authenticateToken, requireAdmin, async (req, res) => {
  const { word, meaning, ipa, example } = req.body;
  const { data, error } = await supabase.from('words').insert([{ word, meaning, ipa, example }]);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Thêm từ vựng thành công!', data });
});

// Xóa từ vựng (CHỈ ADMIN)
app.delete('/api/words/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('words').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Xóa từ vựng thành công!' });
});

// Chấm điểm phát âm (Yêu cầu đăng nhập)
app.post('/api/check-pronunciation', authenticateToken, upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Không tìm thấy file ghi âm' });
    const { targetWord } = req.body;

    const file = new File([req.file.buffer], 'speech.mp3', { type: req.file.mimetype });
    const transcription = await groq.audio.transcriptions.create({
      file: file,
      model: 'whisper-large-v3',
      language: 'en',
    });

    const spokenText = transcription.text.trim().toLowerCase();
    const expectedText = targetWord.trim().toLowerCase();
    const isCorrect = spokenText.includes(expectedText);

    res.json({
      isCorrect,
      spokenText,
      targetWord,
      score: isCorrect ? 100 : 50
    });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi xử lý AI: ' + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));