require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const Groq = require('groq-sdk');

const app = express();
app.use(cors());
app.use(express.json());

// Khởi tạo Supabase và Groq client
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Cấu hình Multer lưu file ghi âm tạm thời vào RAM (không ghi vào đĩa để tiết kiệm bộ nhớ server)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// 1. API Lấy danh sách từ vựng từ Supabase
app.get('/api/words', async (req, res) => {
  const { data, error } = await supabase.from('words').select('*');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 2. API Chấm điểm phát âm bằng Groq Whisper
app.post('/api/check-pronunciation', upload.single('audio'), async (req, res) => {
  try {
    const targetWord = req.body.target_word; // Từ cần đọc (ví dụ: "apple")
    const audioFile = req.file; // File ghi âm gửi từ Android

    if (!audioFile || !targetWord) {
      return res.status(400).json({ error: 'Thiếu file âm thanh hoặc từ cần kiểm tra' });
    }

    // Chuyển file buffer từ RAM thành file ảo để gửi sang Groq API
    const fileForGroq = new File([audioFile.buffer], 'speech.mp3', { type: audioFile.mimetype });

    // Gọi Groq Whisper API để nhận diện giọng nói
    const transcription = await groq.audio.transcriptions.create({
      file: fileForGroq,
      model: 'whisper-large-v3',
      language: 'en',
    });

    const spokenText = transcription.text.trim().toLowerCase();
    const expectedText = targetWord.trim().toLowerCase();

    // So sánh từ người dùng đọc với từ mục tiêu
    const isCorrect = spokenText.includes(expectedText);

    res.json({
      success: true,
      target_word: targetWord,
      user_said: spokenText,
      is_correct: isCorrect,
      message: isCorrect ? 'Phát âm chính xác!' : `Hình như bạn nói thành: "${spokenText}"`
    });

  } catch (error) {
    console.error('Lỗi xử lý:', error);
    res.status(500).json({ error: 'Lỗi server khi phân tích giọng nói' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server đang chạy tại http://localhost:${PORT}`);
});