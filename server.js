const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// APK তৈরির API
app.post('/api/generate-apk', (req, res) => {
    const { appName, webUrl } = req.body;

    if (!webUrl || !appName) {
        return res.status(400).json({ error: "Please provide both App Name and URL!" });
    }

    try {
        const templatePath = path.join(__dirname, 'template.apk');
        
        // টেমপ্লেট APK ফাইল না থাকলে এরর এড়ানোর ব্যবস্থা
        if (!fs.existsSync(templatePath)) {
            return res.status(500).json({ error: "APK Template missing on server." });
        }

        const zip = new AdmZip(templatePath);
        
        // অ্যাপের কনফিগারেশন তৈরি
        const configData = JSON.stringify({ app_name: appName, target_url: webUrl });
        zip.addFile("assets/config.json", Buffer.from(configData, "utf8"));

        const outputFileName = `${appName.replace(/\s+/g, '_')}.apk`;
        const outputPath = path.join(__dirname, 'public', outputFileName);
        
        zip.writeZip(outputPath);

        // ডাউনলোড লিংক ফেরত পাঠানো
        res.json({ downloadUrl: `/${outputFileName}` });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to generate APK" });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
