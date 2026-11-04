const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const AdmZip = require('adm-zip');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// আপনার দেওয়া Supabase ক্রেডেনশিয়াল সরাসরি সেট করা হয়েছে
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jarvddoqktnvwquqocyp.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImphcnZkZG9xa3RudndxdXFvY3lwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI1OTU2MTMsImV4cCI6MjEwODE3MTYxM30.HTY0uRuaXp-ljAUOCJTOE583p5-kbVwCMV5b_DekFRQ';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Multer ফিল্টার (আইকন সর্বোচ্চ ১ MB, HTML সর্বোচ্চ ৫ MB)
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }
});

// ডিভাইস আইডি ও প্রতিদিনের ৫ টোকেন যাচাই
async function verifyAndDeductToken(deviceId) {
    const today = new Date().toISOString().split('T')[0];

    try {
        let { data: user, error } = await supabase
            .from('device_quotas')
            .select('*')
            .eq('device_id', deviceId)
            .single();

        if (!user) {
            await supabase
                .from('device_quotas')
                .insert([{ device_id: deviceId, tokens_remaining: 4, last_reset_date: today }]);
            return { success: true, tokensRemaining: 4 };
        }

        if (user.last_reset_date !== today) {
            await supabase
                .from('device_quotas')
                .update({ tokens_remaining: 4, last_reset_date: today })
                .eq('device_id', deviceId);
            return { success: true, tokensRemaining: 4 };
        }

        if (user.tokens_remaining <= 0) {
            return { success: false, message: "আজকের ৫টি APK তৈরির লিমিট শেষ! কাল আবার চেষ্টা করুন।" };
        }

        const updatedTokens = user.tokens_remaining - 1;
        await supabase
            .from('device_quotas')
            .update({ tokens_remaining: updatedTokens })
            .eq('device_id', deviceId);

        return { success: true, tokensRemaining: updatedTokens };
    } catch (err) {
        console.error("Supabase Error:", err);
        return { success: true, tokensRemaining: 5 }; // ডেটাবেজ ফলব্যাক
    }
}

// বর্তমান টোকেন চেক API
app.get('/api/check-tokens/:deviceId', async (req, res) => {
    const { deviceId } = req.params;
    const today = new Date().toISOString().split('T')[0];

    try {
        let { data: user } = await supabase
            .from('device_quotas')
            .select('*')
            .eq('device_id', deviceId)
            .single();

        if (!user || user.last_reset_date !== today) {
            return res.json({ tokens: 5 });
        }
        return res.json({ tokens: user.tokens_remaining });
    } catch (err) {
        return res.json({ tokens: 5 });
    }
});

// APK তৈরি করার রুট
app.post('/api/create-apk', upload.fields([
    { name: 'appIcon', maxCount: 1 },
    { name: 'htmlZip', maxCount: 1 }
]), async (req, res) => {
    try {
        const { deviceId, appName, packageName, targetUrl, splashAnimation } = req.body;

        if (!appName || !packageName) {
            return res.status(400).json({ error: "App Name এবং Package Name দিন!" });
        }

        // আইকন সাইজ ১ MB চেক
        if (req.files && req.files['appIcon']) {
            if (req.files['appIcon'][0].size > 1024 * 1024) {
                return res.status(400).json({ error: "আইকন সাইজ সর্বোচ্চ ১ MB হতে পারবে!" });
            }
        }

        // HTML Zip সাইজ ৫ MB চেক
        if (req.files && req.files['htmlZip']) {
            if (req.files['htmlZip'][0].size > 5 * 1024 * 1024) {
                return res.status(400).json({ error: "HTML Zip ফাইল সর্বোচ্চ ৫ MB হতে পারবে!" });
            }
        }

        // টোকেন যাচাই
        const tokenCheck = await verifyAndDeductToken(deviceId);
        if (!tokenCheck.success) {
            return res.status(429).json({ error: tokenCheck.message });
        }

        const templatePath = path.join(__dirname, 'template.apk');
        if (!fs.existsSync(templatePath)) {
            return res.status(500).json({ error: "template.apk সার্ভারে পাওয়া যায়নি!" });
        }

        const zip = new AdmZip(templatePath);

        const appConfig = {
            app_name: appName,
            package_name: packageName,
            target_url: targetUrl || "file:///android_asset/www/index.html",
            splash_animation: splashAnimation === "true",
            built_by: "Tʜᴇㅤᴍᴀᴅᴀʀᴀ⁷",
            created_at: new Date().toISOString()
        };

        zip.addFile("assets/config.json", Buffer.from(JSON.stringify(appConfig, null, 2), "utf8"));

        if (req.files && req.files['htmlZip']) {
            const uploadedZip = new AdmZip(req.files['htmlZip'][0].buffer);
            uploadedZip.getEntries().forEach(entry => {
                if (!entry.isDirectory) {
                    zip.addFile(`assets/www/${entry.entryName}`, entry.getData());
                }
            });
        }

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
        console.error("Build Error:", err);
        res.status(500).json({ error: "APK তৈরি করতে সমস্যা হয়েছে!" });
    }
});

app.listen(PORT, () => {
    console.log(`Tʜᴇㅤᴍᴀᴅᴀʀᴀ⁷ Server running on port ${PORT}`);
});
