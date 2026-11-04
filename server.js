const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const AdmZip = require('adm-zip');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase কনফিগারেশন (Render Environment Variables থেকে আসবে)
const SUPABASE_URL = process.env.SUPABASE_URL || 'YOUR_SUPABASE_URL';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'YOUR_SUPABASE_ANON_KEY';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Multer ফাইল আপলোড ফিল্টার (Icon: Max 1MB, HTML/Zip: Max 5MB)
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 } // সর্বোচ্চ ৫ এমবি সীমা
});

// ডিভাইস আইডি যাচাই ও ৫ টোকেন লিমিট লজিক
async function verifyAndDeductToken(deviceId) {
    const today = new Date().toISOString().split('T')[0];

    // ইউজারের ডেটা চেক
    let { data: user, error } = await supabase
        .from('device_quotas')
        .select('*')
        .eq('device_id', deviceId)
        .single();

    if (!user) {
        // নতুন ডিভাইস হলে ৫টি টোকেন দেওয়া হবে
        const { data: newUser } = await supabase
            .from('device_quotas')
            .insert([{ device_id: deviceId, tokens_remaining: 4, last_reset_date: today }])
            .select()
            .single();
        return { success: true, tokensRemaining: 4 };
    }

    // নতুন দিন হলে টোকেন আবার ৫-এ রিসেট হবে
    if (user.last_reset_date !== today) {
        await supabase
            .from('device_quotas')
            .update({ tokens_remaining: 4, last_reset_date: today })
            .eq('device_id', deviceId);
        return { success: true, tokensRemaining: 4 };
    }

    // টোকেন শেষ হলে ব্লক
    if (user.tokens_remaining <= 0) {
        return { success: false, message: "আজকের ৫টি APK তৈরির লিমিট শেষ! কাল আবার চেষ্টা করুন।" };
    }

    // ১টি টোকেন কাটা হচ্ছে
    const updatedTokens = user.tokens_remaining - 1;
    await supabase
        .from('device_quotas')
        .update({ tokens_remaining: updatedTokens })
        .eq('device_id', deviceId);

    return { success: true, tokensRemaining: updatedTokens };
}

// টোকেন সংখ্যা চেক করার API
app.get('/api/check-tokens/:deviceId', async (req, res) => {
    const { deviceId } = req.params;
    const today = new Date().toISOString().split('T')[0];

    let { data: user } = await supabase
        .from('device_quotas')
        .select('*')
        .eq('device_id', deviceId)
        .single();

    if (!user || user.last_reset_date !== today) {
        return res.json({ tokens: 5 });
    }
    return res.json({ tokens: user.tokens_remaining });
});

// APK বিল্ড API
app.post('/api/create-apk', upload.fields([
    { name: 'appIcon', maxCount: 1 },
    { name: 'htmlZip', maxCount: 1 }
]), async (req, res) => {
    try {
        const { deviceId, appName, packageName, targetUrl, splashAnimation } = req.body;

        if (!deviceId || !appName || !packageName) {
            return res.status(400).json({ error: "সব প্রয়োজনীয় তথ্য দিন!" });
        }

        // আইকন সাইজ ভ্যালিডেশন (১ MB)
        if (req.files['appIcon']) {
            const iconSize = req.files['appIcon'][0].size;
            if (iconSize > 1024 * 1024) {
                return res.status(400).json({ error: "অ্যাপ আইকন সর্বোচ্চ ১ MB হতে পারবে!" });
            }
        }

        // এইচটিএমএল সাইজ ভ্যালিডেশন (৫ MB)
        if (req.files['htmlZip']) {
            const zipSize = req.files['htmlZip'][0].size;
            if (zipSize > 5 * 1024 * 1024) {
                return res.status(400).json({ error: "HTML/Zip ফাইল সর্বোচ্চ ৫ MB হতে পারবে!" });
            }
        }

        // টোকেন যাচাই ও কাটা
        const tokenCheck = await verifyAndDeductToken(deviceId);
        if (!tokenCheck.success) {
            return res.status(429).json({ error: tokenCheck.message });
        }

        // টেমপ্লেট APK লোড
        const templatePath = path.join(__dirname, 'template.apk');
        if (!fs.existsSync(templatePath)) {
            return res.status(500).json({ error: "সার্ভারে template.apk পাওয়া যায়নি!" });
        }

        const zip = new AdmZip(templatePath);

        // অ্যাপ কনফিগারেশন তৈরি
        const appConfig = {
            app_name: appName,
            package_name: packageName,
            target_url: targetUrl || "file:///android_asset/www/index.html",
            splash_animation: splashAnimation === "true",
            created_at: new Date().toISOString()
        };

        zip.addFile("assets/config.json", Buffer.from(JSON.stringify(appConfig, null, 2), "utf8"));

        // যদি ইউজার HTML জিপ ফাইল দিয়ে থাকে
        if (req.files['htmlZip']) {
            const uploadedZip = new AdmZip(req.files['htmlZip'][0].buffer);
            const entries = uploadedZip.getEntries();
            entries.forEach(entry => {
                if (!entry.isDirectory) {
                    zip.addFile(`assets/www/${entry.entryName}`, entry.getData());
                }
            });
        }

        // নতুন APK সংরক্ষণ
        const safeName = appName.replace(/[^a-zA-Z0-9]/g, '_');
        const outputFileName = `${safeName}_${Date.now()}.apk`;
        const outputPath = path.join(__dirname, 'public', outputFileName);

        zip.writeZip(outputPath);

        res.json({
            success: true,
            downloadUrl: `/${outputFileName}`,
            tokensRemaining: tokenCheck.tokensRemaining
        });

    } catch (err) {
        console.error("APK Generation Error:", err);
        res.status(500).json({ error: "APK তৈরি করতে সমস্যা হয়েছে!" });
    }
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
