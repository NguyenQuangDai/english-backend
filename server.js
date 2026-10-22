require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const { Groq, toFile } = require('groq-sdk');

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

async function authenticateToken(req, res, next) {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      return res.status(401).json({ error: 'Vui lòng đăng nhập để thực hiện' });
    }

    // Xử lý linh hoạt token có hoặc không có chữ 'Bearer '
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.split(' ')[1]
      : authHeader;

    if (!token) {
      return res.status(401).json({ error: 'Token không hợp lệ' });
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
  } catch (err) {
    console.error('Lỗi Middleware Authenticate:', err.message);
    return res.status(500).json({ error: 'Lỗi xác thực phía Server' });
  }
}

function requireAdmin(req, res, next) {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ error: 'Từ chối truy cập! Thao tác này chỉ dành cho Admin.' });
  }
  next();
}

// ==========================================
// 2. API ĐĂNG KÝ / ĐĂNG NHẬP
// ==========================================

app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Vui lòng nhập Email và Mật khẩu' });

  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) return res.status(400).json({ error: error.message });

  if (data.user) {
    await supabase.from('profiles').insert([{ id: data.user.id, email: data.user.email, role: 'user' }]);
  }

  res.json({ message: 'Đăng ký thành công!', user: data.user });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Vui lòng nhập Email và Mật khẩu' });

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(400).json({ error: 'Email hoặc mật khẩu không chính xác' });

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
// 3. API QUẢN LÝ TỪ VỰNG
// ==========================================

app.get('/api/words', async (req, res) => {
  const { data, error } = await supabase.from('words').select('*');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/words', authenticateToken, requireAdmin, async (req, res) => {
  const { word, meaning, ipa, example } = req.body;
  const { data, error } = await supabase.from('words').insert([{ word, meaning, ipa, example }]);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Thêm từ vựng thành công!', data });
});

app.delete('/api/words/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('words').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Xóa từ vựng thành công!' });
});

// ==========================================
// 4. CHẤM ĐIỂM: LƯU LOG & AUDIO (Đã sửa lỗi 500)
// ==========================================

app.post('/api/check-pronunciation', authenticateToken, upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Thiếu file âm thanh' });
    const { targetWord } = req.body;

    // A. Upload file âm thanh lên Supabase Storage
    const fileName = `${req.user.id}/${Date.now()}.mp3`;
    let publicUrl = '';

    const { error: storageError } = await supabase.storage
      .from('audio-records')
      .upload(fileName, req.file.buffer, { contentType: 'audio/mpeg' });

    if (storageError) {
      console.error('⚠️ Supabase Storage Upload Warning:', storageError.message);
    } else {
      const { data } = supabase.storage.from('audio-records').getPublicUrl(fileName);
      publicUrl = data?.publicUrl || '';
    }

    // B. Chuyển Buffer thành File an toàn bằng helper toFile của Groq SDK
    const audioFile = await toFile(req.file.buffer, 'speech.mp3', {
      type: req.file.mimetype || 'audio/mpeg'
    });

    const transcription = await groq.audio.transcriptions.create({
      file: audioFile,
      model: 'whisper-large-v3',
      language: 'en',
    });

    const spokenText = (transcription.text || '').trim().toLowerCase();
    const expectedText = (targetWord || '').trim().toLowerCase();
    const isCorrect = spokenText.includes(expectedText);
    const score = isCorrect ? 100 : 50;

    // C. Ghi Log vào Database để Admin kiểm soát chất lượng AI
    try {
      await supabase.from('pronunciation_logs').insert([{
        user_id: req.user.id,
        user_email: req.user.email,
        target_word: targetWord || '',
        audio_url: publicUrl,
        ai_spoken_text: spokenText,
        ai_score: score,
        is_flagged: !isCorrect
      }]);
    } catch (logErr) {
      console.error('⚠️ Pronunciation log DB warning:', logErr.message);
    }

    // Trả về JSON chứa cả kiểu camelCase và snake_case cho tương thích với Android App
    res.json({
      isCorrect,
      is_correct: isCorrect,
      spokenText,
      user_said: spokenText,
      targetWord,
      score
    });

  } catch (err) {
    console.error('🔥 Lỗi chấm điểm:', err);
    res.status(500).json({ error: 'Lỗi chấm điểm: ' + err.message });
  }
});

// ==========================================
// 5. API DÀNH RIÊNG CHO ADMIN (KIỂM SOÁT AI)
// ==========================================

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

app.get('/api/admin/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { count: totalLogs } = await supabase.from('pronunciation_logs').select('*', { count: 'exact', head: true });
    const { count: flaggedLogs } = await supabase.from('pronunciation_logs').select('*', { count: 'exact', head: true }).eq('is_flagged', true);
    const { count: totalUsers } = await supabase.from('profiles').select('*', { count: 'exact', head: true });

    const totalLogsNum = totalLogs || 0;
    const flaggedLogsNum = flaggedLogs || 0;
    const estimatedCost = (totalLogsNum * 0.0001).toFixed(4);

    res.json({
      totalUsers: totalUsers || 0,
      totalAudioScored: totalLogsNum,
      flaggedCases: flaggedLogsNum,
      aiAccuracyRate: totalLogsNum ? (((totalLogsNum - flaggedLogsNum) / totalLogsNum) * 100).toFixed(1) + '%' : '100%',
      estimatedAiCost: `$${estimatedCost}`
    });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi tính toán thống kê: ' + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));