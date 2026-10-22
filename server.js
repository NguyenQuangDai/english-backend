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

// ==========================================
// 1. CẬP NHẬT CHẤM ĐIỂM: LƯU LOG & AUDIO
// ==========================================
app.post('/api/check-pronunciation', authenticateToken, upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Thiếu file âm thanh' });
    const { targetWord } = req.body;

    // A. Upload file âm thanh lên Supabase Storage
    const fileName = `${req.user.id}/${Date.now()}.mp3`;
    const { data: storageData, error: storageError } = await supabase.storage
      .from('audio-records')
      .upload(fileName, req.file.buffer, { contentType: 'audio/mpeg' });

    if (storageError) throw storageError;

    // Lấy URL công khai của file ghi âm
    const { data: { publicUrl } } = supabase.storage
      .from('audio-records')
      .getPublicUrl(fileName);

    // B. Gọi Groq AI phân tích phát âm
    const file = new File([req.file.buffer], 'speech.mp3', { type: req.file.mimetype });
    const transcription = await groq.audio.transcriptions.create({
      file: file,
      model: 'whisper-large-v3',
      language: 'en',
    });

    const spokenText = transcription.text.trim().toLowerCase();
    const expectedText = targetWord.trim().toLowerCase();
    const isCorrect = spokenText.includes(expectedText);
    const score = isCorrect ? 100 : 50;

    // C. Ghi Log vào Database để Admin kiểm soát chất lượng AI
    await supabase.from('pronunciation_logs').insert([{
      user_id: req.user.id,
      user_email: req.user.email,
      target_word: targetWord,
      audio_url: publicUrl,
      ai_spoken_text: spokenText,
      ai_score: score,
      is_flagged: !isCorrect // Tự động cờ báo các câu bị AI chấm rớt để Admin rà soát
    }]);

    res.json({ isCorrect, spokenText, targetWord, score });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi chấm điểm: ' + err.message });
  }
});

// ==========================================
// 2. API DÀNH RIÊNG CHO ADMIN (KIỂM SOÁT AI)
// ==========================================

// Lấy danh sách lịch sử thu âm (Hỗ trợ lọc các câu bị cờ báo sai)
app.get('/api/admin/logs', authenticateToken, requireAdmin, async (req, res) => {
  const { flaggedOnly } = req.query;
  let query = supabase.from('pronunciation_logs').select('*').order('created_at', { ascending: false });

  if (flaggedOnly === 'true') {
    query = query.eq('is_flagged', true);
  }

  const { data, error } = await query.limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Admin điều chỉnh lại điểm và ghi chú cho AI
app.put('/api/admin/logs/:id/review', authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { correctedScore, adminNote, unflag } = req.body;

  const { error } = await supabase
    .from('pronunciation_logs')
    .update({
      admin_corrected_score: correctedScore,
      admin_note: adminNote,
      is_flagged: !unflag
    })
    .eq('id', id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Đã cập nhật đánh giá AI' });
});

// Báo cáo thống kê vận hành & Chi phí AI
app.get('/api/admin/stats', authenticateToken, requireAdmin, async (req, res) => {
  const { count: totalLogs } = await supabase.from('pronunciation_logs').select('*', { count: 'exact', head: true });
  const { count: flaggedLogs } = await supabase.from('pronunciation_logs').select('*', { count: 'exact', head: true }).eq('is_flagged', true);
  const { count: totalUsers } = await supabase.from('profiles').select('*', { count: 'exact', head: true });

  // Ước tính chi phí Groq Whisper (ví dụ: $0.0001 / lượt thu âm)
  const estimatedCost = (totalLogs * 0.0001).toFixed(4);

  res.json({
    totalUsers: totalUsers || 0,
    totalAudioScored: totalLogs || 0,
    flaggedCases: flaggedLogs || 0,
    aiAccuracyRate: totalLogs ? (((totalLogs - flaggedLogs) / totalLogs) * 100).toFixed(1) + '%' : '100%',
    estimatedAiCost: `$${estimatedCost}`
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));