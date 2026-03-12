// ENcheckCourseSeatAvailable.js

import fetch from "node-fetch";
import chalk from "chalk";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import readline from "readline";
import fs from "fs"; 

dotenv.config({ path: './email_info.env' });

// ================= GLOBAL CONFIGURATION =================
let TERM = "";                    // Dynamic term (e.g., 202603)
let COURSES_TO_MONITOR = [];      // Course monitoring list
let enableEmailAlerts = true;     // Global email alert toggle

const BASE_URL = "https://prodapps.isadm.oregonstate.edu/StudentRegistrationSsb/ssb";
const SEARCH_URL = `${BASE_URL}/searchResults/searchResults`;
const START_URL = `${BASE_URL}/classSearch/classSearch`;
const TERM_URL = `${BASE_URL}/term/search?mode=search`;
const RESET_URL = `${BASE_URL}/classSearch/resetDataForm`;
const RESTRICTIONS_URL = `${BASE_URL}/searchResults/getRestrictions`; 

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

let dynamicCookie = "";
let dynamicToken = "";
let lastRefreshTime = 0;

// Create CLI interface
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});
const askQuestion = (query) => new Promise(resolve => rl.question(query, resolve));

// NEW: Powerful prompt function with "go back" support
async function askWithBack(questions) {
    let answers = [];
    let i = 0;
    while (i < questions.length) {
        let promptText = questions[i].prompt;
        // If not the first question, remind user they can go back
        if (i > 0) {
            promptText = chalk.gray("[Type '-' to go back] ") + promptText;
        }

        let ans = await askQuestion(promptText);
        ans = ans.trim();

        // Intercept 'go back' command
        if (ans === '-' && i > 0) {
            i--; // Decrement index to go back one question
            continue;
        } else if (ans === '-' && i === 0) {
            console.log(chalk.red("You are already at the first question!"));
            continue;
        }

        // Validate user input
        if (questions[i].validate) {
            let isValid = questions[i].validate(ans);
            if (!isValid) continue; // If invalid, repeat the current question
        }

        answers[i] = ans;
        i++;
    }
    return answers;
}

// ================= UTILITY FUNCTIONS =================
function getPacificTime() {
    return new Date().toLocaleString("en-US", { 
        timeZone: "America/Los_Angeles", 
        hour12: false 
    });
}

// ================= EMAIL CONFIGURATION =================
let transporter;

function initTransporter() {
    transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT),
        secure: true,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
}
initTransporter();

const COOLDOWN_MS = 3600_000; 
const lastMailTSMap = new Map(); 

async function verifyEmailConfig() {
    console.log(chalk.blue(`[${getPacificTime()}] Verifying email configuration (email_info.env)...`));
    try {
        await transporter.verify();
        console.log(chalk.green(`[${getPacificTime()}] Email configuration verified successfully! Alerts are ENABLED.`));
        return true;
    } catch (error) {
        return false;
    }
}

async function configureEnvFile() {
    console.log(chalk.cyan("\n=== Email Setup Wizard ==="));
    console.log(chalk.gray("email_info.env is missing or incorrect. Let's set it up.\n"));
    
    console.log(chalk.bgYellow.black(" [IMPORTANT: How to get Gmail App Password] "));
    console.log(chalk.white("Due to Google's security policy, you cannot use your standard login password. Follow these steps:"));
    console.log(chalk.white(`1. Enable "2-Step Verification":`));
    console.log(`   Ctrl+Click (or copy to browser): ${chalk.underline.blueBright('https://myaccount.google.com/intro/security')}`);
    console.log(chalk.white(`2. Generate an App Password:`));
    console.log(`   Ctrl+Click (or copy to browser): ${chalk.underline.blueBright('https://myaccount.google.com/apppasswords')}`);
    console.log(chalk.white("3. Generate a 16-character password and copy it. You will paste it below.\n"));
    
    let envQs = [
        { prompt: chalk.yellow("Enter SMTP Host (Press Enter for default 'smtp.gmail.com'): "), validate: () => true },
        { prompt: chalk.yellow("Enter SMTP Port (Press Enter for default '465'): "), validate: () => true },
        { prompt: chalk.yellow("Enter your sending Email Address (e.g., xxx@gmail.com): "), validate: ans => ans.includes("@") ? true : (console.log(chalk.red("Please enter a valid email format!")), false) },
        { prompt: chalk.yellow("Paste your 16-character App Password here: "), validate: ans => ans.length > 0 ? true : (console.log(chalk.red("Password cannot be empty!")), false) },
        { prompt: chalk.yellow("Enter the destination Email Address to receive alerts: "), validate: ans => ans.includes("@") ? true : (console.log(chalk.red("Please enter a valid email format!")), false) }
    ];

    const answers = await askWithBack(envQs);
    const host = answers[0] || "smtp.gmail.com";
    const port = answers[1] || "465";
    const user = answers[2];
    const pass = answers[3];
    const mailTo = answers[4];

    const envContent = `SMTP_HOST=${host}\nSMTP_PORT=${port}\nSMTP_USER=${user}\nSMTP_PASS=${pass}\nMAIL_FROM=${user}\nMAIL_TO=${mailTo}\n`;

    try {
        fs.writeFileSync('./email_info.env', envContent, { encoding: 'utf8' });
        process.env.SMTP_HOST = host; process.env.SMTP_PORT = port;
        process.env.SMTP_USER = user; process.env.SMTP_PASS = pass;
        process.env.MAIL_FROM = user; process.env.MAIL_TO = mailTo;
        initTransporter();
        console.log(chalk.green("\nSuccess: email_info.env file has been created and applied!"));
        return true;
    } catch (err) {
        console.error(chalk.red(`\nFailed to write configuration file: ${err.message}`));
        return false;
    }
}

async function sendEmailAlert(courseKey, subject, htmlBody) {
    if (!enableEmailAlerts) return; 

    const now = Date.now();
    const lastTS = lastMailTSMap.get(courseKey) || 0;
    
    if (now - lastTS < COOLDOWN_MS) {
        console.log(chalk.blue(`[${getPacificTime()}] [${courseKey}] Cooldown: Only ${((now - lastTS) / 1000).toFixed(1)}s since last email alert.`));
        return;
    }
    
    try {
        const info = await transporter.sendMail({ from: process.env.MAIL_FROM, to: process.env.MAIL_TO, subject, html: htmlBody });
        lastMailTSMap.set(courseKey, now); 
        console.log(chalk.green(`[${getPacificTime()}] [${courseKey}] Alert email sent, MessageID: ${info.messageId}`));
    } catch (err) {
        console.error(chalk.red(`[${getPacificTime()}] [${courseKey}] Failed to send email: ${err.message}`));
    }
}

// ================= CORE LOGIC =================
async function refreshSession() {
    console.log(chalk.blue(`[${getPacificTime()}] Fetching latest Cookie and Token...`));
    try {
        const res = await fetch(START_URL, { headers: { "User-Agent": USER_AGENT } });
        let cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : (res.headers.raw()['set-cookie'] || []);
        if (cookies.length > 0) dynamicCookie = cookies.map(c => c.split(';')[0]).join('; ');

        const html = await res.text();
        const tokenMatch = html.match(/name="synchronizerToken"\s+content="([^"]+)"/i) || html.match(/content="([^"]+)"\s+name="synchronizerToken"/i);
        if (tokenMatch && tokenMatch[1]) dynamicToken = tokenMatch[1];
        else throw new Error("synchronizerToken not found.");

        const termRes = await fetch(TERM_URL, {
            method: "POST",
            headers: {
                "Cookie": dynamicCookie, "X-Synchronizer-Token": dynamicToken,
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "User-Agent": USER_AGENT, "X-Requested-With": "XMLHttpRequest"
            },
            body: new URLSearchParams({ term: TERM }).toString()
        });

        if (!termRes.ok) throw new Error(`Failed to bind term: ${termRes.status}`);
        
        lastRefreshTime = Date.now();
        console.log(chalk.green(`[${getPacificTime()}] Session initialized successfully! Token: ${dynamicToken.substring(0, 8)}...`));
    } catch (e) {
        console.error(chalk.red(`[${getPacificTime()}] Failed to auto-fetch credentials: ${e.message}`));
    }
}

async function resetSearch() {
    try {
        await fetch(RESET_URL, {
            method: "POST",
            headers: { "Cookie": dynamicCookie, "X-Synchronizer-Token": dynamicToken, "content-type": "application/x-www-form-urlencoded; charset=UTF-8", "User-Agent": USER_AGENT, "X-Requested-With": "XMLHttpRequest" },
            body: ""
        });
    } catch (e) { }
}

async function fetchCourseData(subject, courseNumber, isRetry = false) {
    if (!dynamicCookie || !dynamicToken) await refreshSession();
    await resetSearch();

    const params = new URLSearchParams({
        txt_subject: subject, txt_courseNumber: courseNumber, txt_term: TERM,
        startDatepicker: "", endDatepicker: "", uniqueSessionId: Date.now(),
        pageOffset: "0", pageMaxSize: "50", sortColumn: "subjectDescription", sortDirection: "asc"
    });

    const res = await fetch(`${SEARCH_URL}?${params.toString()}`, {
        method: "GET",
        headers: { "accept": "application/json, text/javascript, */*; q=0.01", "sec-fetch-mode": "cors", "user-agent": USER_AGENT, "x-requested-with": "XMLHttpRequest", "x-synchronizer-token": dynamicToken, "cookie": dynamicCookie }
    });

    if ((res.status === 401 || res.status === 403 || res.status === 400) && !isRetry) {
        await refreshSession(); return fetchCourseData(subject, courseNumber, true);
    }
    if (!res.ok) throw new Error(`API HTTP ${res.status}`);
    return await res.json();
}

async function fetchRestrictions(crn, isRetry = false) {
    const res = await fetch(RESTRICTIONS_URL, {
        method: "POST",
        headers: { "accept": "text/html, */*; q=0.01", "content-type": "application/x-www-form-urlencoded; charset=UTF-8", "user-agent": USER_AGENT, "x-requested-with": "XMLHttpRequest", "x-synchronizer-token": dynamicToken, "cookie": dynamicCookie, "referer": START_URL },
        body: new URLSearchParams({ term: TERM, courseReferenceNumber: crn }).toString()
    });

    if ((res.status === 401 || res.status === 403 || res.status === 400) && !isRetry) {
        await refreshSession(); return fetchRestrictions(crn, true);
    }
    if (!res.ok) throw new Error(`getRestrictions HTTP ${res.status}`);
    return await res.text();
}

async function checkPerfectSection(course) {
    const { subject, courseNumber, checkOnlineOnly, monitorMode } = course;
    const modeText = checkOnlineOnly ? "[Online]" : "[In-Person]";
    
    let typeText = "";
    if (monitorMode === '1') typeText = "[Available Seat]";
    else if (monitorMode === '2') typeText = "[Waitlist]";
    else typeText = "[Seat OR Waitlist]";

    const courseKey = `${subject}_${courseNumber}_${checkOnlineOnly ? 'Online' : 'InPerson'}_M${monitorMode}`;
    
    try {
        const json = await fetchCourseData(subject, courseNumber);
        if (!json || !json.success || !json.data) return;

        const availableCourses = json.data.filter(c => {
            const isOnlineSchedule = c.scheduleTypeDescription === "Online";
            const isEcampus = c.campusDescription && c.campusDescription.includes("Ecampus");
            const isOnlineCourse = isOnlineSchedule || isEcampus;
            const sectionNum = c.sequenceNumber || ""; 

            if (checkOnlineOnly) {
                if (!isOnlineCourse) return false; 
            } else {
                if (isOnlineCourse) return false; 
                if (!sectionNum.startsWith("0")) return false; 
            }

            // Verify availability based on selected mode
            let meetsCriteria = false;
            if (monitorMode === '1') {
                meetsCriteria = c.seatsAvailable > 0;
            } else if (monitorMode === '2') {
                meetsCriteria = c.waitAvailable > 0;
            } else {
                meetsCriteria = (c.seatsAvailable > 0 || c.waitAvailable > 0);
            }
            return meetsCriteria;
        });

        if (availableCourses.length === 0) {
            console.log(chalk.gray(`[${getPacificTime()}] Scanning ${subject} ${courseNumber} ${modeText} ${typeText}... No availability yet.`));
            return;
        }

        const perfectCourses = [];
        const restrictionBlacklist = [
            "Dist. Degree Corvallis Student(DSC)",
            "Oregon State - Corvallis (C)"
        ];

        for (const c of availableCourses) {
            try {
                const html = await fetchRestrictions(c.courseReferenceNumber);
                let foundRestriction = null;
                for (const keyword of restrictionBlacklist) {
                    if (html.includes(keyword)) {
                        foundRestriction = keyword;
                        break;
                    }
                }

                if (!foundRestriction) {
                    perfectCourses.push(c);
                } else {
                    console.log(chalk.yellow(`[${getPacificTime()}] [${subject} ${courseNumber}] CRN ${c.courseReferenceNumber} has space, but was blocked: Detected "${foundRestriction}" restriction.`));
                }
            } catch (err) {
                console.error(chalk.red(`[${getPacificTime()}] Failed to fetch restrictions for CRN ${c.courseReferenceNumber}: ${err.message}`));
            }
        }

        if (perfectCourses.length > 0) {
            console.log(chalk.green(`[${getPacificTime()}] [${subject} ${courseNumber}] Found ${perfectCourses.length} perfect ${modeText} option(s) matching your criteria with NO restrictions!`));

            let detailsHtml = perfectCourses.map(c => `
                <li style="margin-bottom: 10px;">
                    <b>CRN:</b> ${c.courseReferenceNumber}<br/>
                    <b>Title:</b> ${c.courseTitle}<br/>
                    <b>Type:</b> ${c.scheduleTypeDescription} (${c.campusDescription})<br/>
                    <b>Seats Available:</b> <span style="color:red; font-weight:bold">${c.seatsAvailable} / ${c.maximumEnrollment}</span><br/>
                    <b>Waitlist Available:</b> <span style="color:red; font-weight:bold">${c.waitAvailable}</span>
                </li>
            `).join("");

            const mailSubject = `Found available space for ${subject} ${courseNumber} ${modeText} ${typeText}`;
            const body = `
                <h2>Found ${modeText} options for ${subject} ${courseNumber} matching your ${typeText} requirement!</h2>
                <p>The following sections meet your criteria and have <b>NO DSC or Corvallis campus restrictions detected</b>:</p>
                <ul>${detailsHtml}</ul>
                <p>Please head to the <a href="https://prodapps.isadm.oregonstate.edu/StudentRegistrationSsb/ssb/registration#">OSU Registration System</a> ASAP!</p>
            `;
            await sendEmailAlert(courseKey, mailSubject, body);
        }

    } catch (error) {
        console.error(chalk.red(`[${getPacificTime()}] [${subject} ${courseNumber}] Scan encountered an error: ${error.message}`));
    }
}

async function monitorAllCourses() {
    if (Date.now() - lastRefreshTime >= 300_000) {
        console.log(chalk.magenta(`[${getPacificTime()}] 5 minutes have passed since last refresh. Proactively refreshing session...`));
        await refreshSession();
    }

    console.log(chalk.cyan(`\n--- Starting a new full scan (${getPacificTime()}) ---`));
    
    for (const course of COURSES_TO_MONITOR) {
        await checkPerfectSection(course);
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    setTimeout(monitorAllCourses, 15_000);
}

// ================= INTERACTIVE SETUP =================
async function setupCoursesInteractively() {
    console.log(chalk.cyan(`\n=== Welcome to OSU Course Monitor ===`));

    // 1. Setup global term
    let termQs = [
        {
            prompt: chalk.yellow("Enter the year to monitor (e.g., 2026): "),
            validate: ans => /^\d{4}$/.test(ans) ? true : (console.log(chalk.red("Invalid year format, please enter 4 digits!")), false)
        },
        {
            prompt: chalk.yellow("Select the term:\n  [1] Fall\n  [2] Winter\n  [3] Spring\n  [4] Summer\nEnter your choice (1/2/3/4): "),
            validate: ans => ['1','2','3','4'].includes(ans) ? true : (console.log(chalk.red("Invalid option, please enter a number between 1 and 4!")), false)
        }
    ];

    console.log(chalk.bgCyan.black(" [Step 1: Term Configuration] "));
    let termAns = await askWithBack(termQs);
    const termMap = { '1': '01', '2': '02', '3': '03', '4': '04' };
    TERM = termAns[0] + termMap[termAns[1]];
    console.log(chalk.green(`\n✅ Term successfully locked to: ${TERM}`));

    // 2. Loop to add courses
    console.log(chalk.bgCyan.black("\n [Step 2: Course Configuration] "));
    let addMore = true;

    while (addMore) {
        console.log(chalk.bold(`\n[Adding Course #${COURSES_TO_MONITOR.length + 1}]`));
        
        let courseQs = [
            {
                prompt: chalk.yellow("Enter Subject (e.g., CS, MTH): "),
                validate: ans => /^[A-Za-z]+$/.test(ans) ? true : (console.log(chalk.red("Subject must contain ONLY letters (no spaces or numbers)!")), false)
            },
            {
                prompt: chalk.yellow("Enter Course Number (e.g., 123, 456): "),
                validate: ans => /^\d+$/.test(ans) ? true : (console.log(chalk.red("Course number must contain ONLY digits!")), false)
            },
            {
                prompt: chalk.yellow("Monitor ONLY online sections? (y/n, press Enter for default 'y'): "),
                validate: ans => {
                    const val = ans.trim().toLowerCase();
                    if (val === '' || val === 'y' || val === 'n') return true;
                    console.log(chalk.red("Invalid input, please enter 'y', 'n', or just press Enter!"));
                    return false;
                }
            },
            {
                prompt: chalk.yellow("What availability do you want to monitor?\n  [1] Open Seats ONLY (Seat > 0)\n  [2] Waitlist Spots ONLY (Waitlist > 0)\n  [3] BOTH (Alert if either seat OR waitlist opens up)\nEnter choice (1/2/3, press Enter for default '3'): "),
                validate: ans => (ans === '' || ['1','2','3'].includes(ans)) ? true : (console.log(chalk.red("Invalid option, please enter 1/2/3 or press Enter!")), false)
            }
        ];

        let courseAns = await askWithBack(courseQs);
        let subject = courseAns[0].toUpperCase();
        let courseNumber = courseAns[1];
        let checkOnlineOnly = courseAns[2].toLowerCase() !== 'n'; // Default true unless explicitly 'n'
        let monitorMode = courseAns[3] || '3';                    // Default 3

        COURSES_TO_MONITOR.push({
            subject: subject,
            courseNumber: courseNumber,
            checkOnlineOnly: checkOnlineOnly,
            monitorMode: monitorMode
        });

        console.log(chalk.green(`✅ Successfully added: ${subject} ${courseNumber}`));

        const moreInput = await askQuestion(chalk.green("\nAdd another course to monitor? (y/n, press Enter for default 'n'): "));
        addMore = moreInput.trim().toLowerCase() === 'y';
    }
}

// ================= START PROGRAM =================
(async () => {
    console.log(chalk.blue(`[${getPacificTime()}] Disclaimer: This program is for educational and research purposes only. Do not use for any commercial or illegal activities.`));
    
    // 1. Initial Email Verification
    let emailOk = await verifyEmailConfig();
    
    if (!emailOk) {
        console.log(chalk.bgRed.white("\n WARNING: Email verification failed (Missing env file or incorrect credentials) "));
        console.log("Options:");
        console.log("  [1] Run WITHOUT email alerts (Console alerts only)");
        console.log("  [2] Configure email settings now (Create/Overwrite .env file)");
        console.log("  [3] Exit program");
        
        while (true) {
            const ans = await askQuestion(chalk.yellow("\nEnter your choice (1/2/3): "));
            const choice = ans.trim();
            
            if (choice === '1') {
                enableEmailAlerts = false;
                console.log(chalk.magenta(`\n[${getPacificTime()}] Running without email alerts. Notifications will only appear in this console.`));
                break;
            } else if (choice === '2') {
                const configSuccess = await configureEnvFile();
                if (configSuccess) {
                    const reVerify = await verifyEmailConfig();
                    if (!reVerify) {
                        console.log(chalk.red(`\n[${getPacificTime()}] Still failing to verify after setup. Program will exit. Please check your credentials.`));
                        rl.close();
                        process.exit(1);
                    }
                    break;
                } else {
                    rl.close();
                    process.exit(1);
                }
            } else if (choice === '3') {
                console.log(chalk.red(`\n[${getPacificTime()}] Program exited.`));
                rl.close();
                process.exit(0);
            } else {
                console.log(chalk.red("Invalid option, please enter 1, 2, or 3!"));
            }
        }
    }

    // 2. Interactive Course Setup
    await setupCoursesInteractively();
    rl.close(); 

    if (COURSES_TO_MONITOR.length === 0) {
        console.log(chalk.red("No courses added. Program will exit."));
        return;
    }

    // 3. Start Monitoring
    console.log(chalk.magenta(`\n[${getPacificTime()}] Setup complete! Starting monitor for ${COURSES_TO_MONITOR.length} course(s)...`));
    await refreshSession();
    await monitorAllCourses(); 
})();