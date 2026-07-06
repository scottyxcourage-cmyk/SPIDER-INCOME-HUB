const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT) || 587,
  secure: false, // true for port 465
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

const sendOTP = async (toEmail, toName, otp) => {
  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to: toEmail,
    subject: 'SpiderHub - Your OTP Code',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;background:#0a0f1e;color:#fff;border-radius:12px;padding:32px;">
        <h2 style="color:#00e5ff;margin-bottom:8px;">SpiderHub 🔐</h2>
        <p>Hi <strong>${toName}</strong>,</p>
        <p>Your one-time verification code is:</p>
        <div style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#00e5ff;text-align:center;padding:20px;background:#111827;border-radius:8px;margin:20px 0;">
          ${otp}
        </div>
        <p style="color:#aaa;font-size:13px;">This code expires in <strong>10 minutes</strong>. Do not share it with anyone.</p>
        <p style="color:#555;font-size:12px;margin-top:24px;">— SpiderHub Team</p>
      </div>
    `
  });
};

const sendVerification = async (toEmail, toName, otp) => {
  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to: toEmail,
    subject: 'SpiderHub - Verify Your Account',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;background:#0a0f1e;color:#fff;border-radius:12px;padding:32px;">
        <h2 style="color:#00e5ff;margin-bottom:8px;">Welcome to SpiderHub 👋</h2>
        <p>Hi <strong>${toName}</strong>, thanks for signing up!</p>
        <p>Use this code to verify your account:</p>
        <div style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#00e5ff;text-align:center;padding:20px;background:#111827;border-radius:8px;margin:20px 0;">
          ${otp}
        </div>
        <p style="color:#aaa;font-size:13px;">This code expires in <strong>10 minutes</strong>.</p>
        <p style="color:#555;font-size:12px;margin-top:24px;">— SpiderHub Team</p>
      </div>
    `
  });
};

module.exports = { sendOTP, sendVerification };
