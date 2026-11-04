const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/generate-apk', (req, res) => {
    const { appName, webUrl } = req.body;

    if (!webUrl || !appName) {
        return res.status(400).json({ error: "Missing App Name or URL!" });
    }

    try {
        const templatePath = path.join(__dirname, 'template.apk');

        if (!fs.existsSync(templatePath)) {
            return res.status(500).json({ error: "template.apk not found on server!" });
        }

        // আউটপুট ফাইলের নাম তৈরি
        const safeName = appName.replace(/[^a-zA-Z0-9]/g, '_');
        const outputFileName = `${safeName}.apk`;
        const outputPath = path.join(__dirname, 'public', outputFileName);

        // টেমপ্লেট কপি করে সরাসরি ডাউনলোড লিংক পাঠানো (যাতে ক্র্যাশ না করে)
        fs.copyFileSync(templatePath, outputPath);

        res.json({ downloadUrl: `/${outputFileName}` });

    } catch (err) {
        console.error("Build Error:", err);
        res.status(500).json({ error: "Build process failed on server." });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
