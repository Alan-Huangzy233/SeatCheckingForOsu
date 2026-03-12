// checkCourseatAvailable.js

import fetch from "node-fetch";
import chalk from "chalk";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import readline from "readline";
import fs from "fs"; 

dotenv.config({ path: './email_info.env' });

// ================= 全局变量配置 =================
let TERM = "";                    // 动态学期 (如 202603)
let COURSES_TO_MONITOR = [];      // 监控列表
let enableEmailAlerts = true;     // 全局邮件提醒开关

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

// 创建命令行交互接口
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});
const askQuestion = (query) => new Promise(resolve => rl.question(query, resolve));

// 新增：支持“返回上一题”的强力提问器
async function askWithBack(questions) {
    let answers = [];
    let i = 0;
    while (i < questions.length) {
        let promptText = questions[i].prompt;
        // 如果不是第一题，提示用户可以输入 '-' 返回
        if (i > 0) {
            promptText = chalk.gray("[输入 '-' 返回上一题] ") + promptText;
        }

        let ans = await askQuestion(promptText);
        ans = ans.trim();

        // 拦截返回指令
        if (ans === '-' && i > 0) {
            i--; // 题号减一，退回上一题
            continue;
        } else if (ans === '-' && i === 0) {
            console.log(chalk.red("当前已经是第一题了！"));
            continue;
        }

        // 验证用户输入
        if (questions[i].validate) {
            let isValid = questions[i].validate(ans);
            if (!isValid) continue; // 如果验证失败，重新问当前这题（验证函数内需自行输出报错提醒）
        }

        answers[i] = ans;
        i++;
    }
    return answers;
}

// ================= 工具函数 =================
function getPacificTime() {
    return new Date().toLocaleString("zh-CN", { 
        timeZone: "America/Los_Angeles", 
        hour12: false 
    });
}

// ================= 邮件配置 =================
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
    console.log(chalk.blue(`[${getPacificTime()}] 正在验证邮件配置 (email_info.env)...`));
    try {
        await transporter.verify();
        console.log(chalk.green(`[${getPacificTime()}] 邮件配置验证成功！已启用邮件提醒功能。`));
        return true;
    } catch (error) {
        return false;
    }
}

async function configureEnvFile() {
    console.log(chalk.cyan("\n=== 邮件配置向导 (Email Setup Wizard) ==="));
    console.log(chalk.gray("检测到 email_info.env 缺失或配置错误。现在将引导您进行配置。\n"));
    
    console.log(chalk.bgYellow.black(" 【重要提示：如何获取 Gmail 授权码 (App Password)】 "));
    console.log(chalk.white("由于 Google 的安全政策，您不能直接使用邮箱的日常登录密码。请按以下步骤操作："));
    console.log(chalk.white(`1. 开启“两步验证 (2-Step Verification)”：`));
    console.log(`   请按住 Ctrl 键点击 (或复制到浏览器): ${chalk.underline.blueBright('https://myaccount.google.com/intro/security')}`);
    console.log(chalk.white(`2. 获取 Gmail 应用专用密码 (App Password)：`));
    console.log(`   请按住 Ctrl 键点击 (或复制到浏览器): ${chalk.underline.blueBright('https://myaccount.google.com/apppasswords')}`);
    console.log(chalk.white("3. 生成一个 16 位的专用密码，并将其复制。我们稍后会用到它。\n"));
    
    let envQs = [
        { prompt: chalk.yellow("请输入 SMTP 服务器地址 (直接回车默认 smtp.gmail.com): "), validate: () => true },
        { prompt: chalk.yellow("请输入 SMTP 端口 (直接回车默认 465): "), validate: () => true },
        { prompt: chalk.yellow("请输入你的发件邮箱地址 (例如 xxx@gmail.com): "), validate: ans => ans.includes("@") ? true : (console.log(chalk.red("请输入有效的邮箱格式！")), false) },
        { prompt: chalk.yellow("请输入你刚刚获取的 16 位专用密码 (直接粘贴): "), validate: ans => ans.length > 0 ? true : (console.log(chalk.red("密码不能为空！")), false) },
        { prompt: chalk.yellow("请输入接收提醒的目标邮箱地址 (可以是同一个邮箱): "), validate: ans => ans.includes("@") ? true : (console.log(chalk.red("请输入有效的邮箱格式！")), false) }
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
        console.log(chalk.green("\n设置成功：email_info.env 文件已自动生成并应用！"));
        return true;
    } catch (err) {
        console.error(chalk.red(`\n写入配置文件失败: ${err.message}`));
        return false;
    }
}

async function sendEmailAlert(courseKey, subject, htmlBody) {
    if (!enableEmailAlerts) return; 

    const now = Date.now();
    const lastTS = lastMailTSMap.get(courseKey) || 0;
    
    if (now - lastTS < COOLDOWN_MS) {
        console.log(chalk.blue(`[${getPacificTime()}] [${courseKey}] 冷却中：距离上次邮件只有 ${((now - lastTS) / 1000).toFixed(1)}s`));
        return;
    }
    
    try {
        const info = await transporter.sendMail({ from: process.env.MAIL_FROM, to: process.env.MAIL_TO, subject, html: htmlBody });
        lastMailTSMap.set(courseKey, now); 
        console.log(chalk.green(`[${getPacificTime()}] [${courseKey}] 提醒邮件已发送，MessageID: ${info.messageId}`));
    } catch (err) {
        console.error(chalk.red(`[${getPacificTime()}] [${courseKey}] 邮件发送失败: ${err.message}`));
    }
}

// ================= 核心逻辑 =================
async function refreshSession() {
    console.log(chalk.blue(`[${getPacificTime()}] 正在获取最新的 Cookie 和 Token`));
    try {
        const res = await fetch(START_URL, { headers: { "User-Agent": USER_AGENT } });
        let cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : (res.headers.raw()['set-cookie'] || []);
        if (cookies.length > 0) dynamicCookie = cookies.map(c => c.split(';')[0]).join('; ');

        const html = await res.text();
        const tokenMatch = html.match(/name="synchronizerToken"\s+content="([^"]+)"/i) || html.match(/content="([^"]+)"\s+name="synchronizerToken"/i);
        if (tokenMatch && tokenMatch[1]) dynamicToken = tokenMatch[1];
        else throw new Error("未找到 synchronizerToken。");

        const termRes = await fetch(TERM_URL, {
            method: "POST",
            headers: {
                "Cookie": dynamicCookie, "X-Synchronizer-Token": dynamicToken,
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "User-Agent": USER_AGENT, "X-Requested-With": "XMLHttpRequest"
            },
            body: new URLSearchParams({ term: TERM }).toString()
        });

        if (!termRes.ok) throw new Error(`绑定学期失败: ${termRes.status}`);
        
        lastRefreshTime = Date.now();
        console.log(chalk.green(`[${getPacificTime()}] Session 初始化成功! Token: ${dynamicToken.substring(0, 8)}...`));
    } catch (e) {
        console.error(chalk.red(`[${getPacificTime()}] 自动获取凭证失败: ${e.message}`));
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
    const modeText = checkOnlineOnly ? "【网课】" : "【线下课】";
    
    let typeText = "";
    if (monitorMode === '1') typeText = "「可用座位(Seat)」";
    else if (monitorMode === '2') typeText = "「等待队列(Waitlist)」";
    else typeText = "「座位或Waitlist」";

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

            // 新增逻辑：根据用户选择的模式验证是否有空位
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
            console.log(chalk.gray(`[${getPacificTime()}] 扫描 ${subject} ${courseNumber} ${modeText}${typeText}，暂无空位...`));
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
                    console.log(chalk.yellow(`[${getPacificTime()}] [${subject} ${courseNumber}] CRN ${c.courseReferenceNumber} 有空位，但被拦截: 检测到 “${foundRestriction}”`));
                }
            } catch (err) {
                console.error(chalk.red(`[${getPacificTime()}] 获取 CRN ${c.courseReferenceNumber} 的限制失败: ${err.message}`));
            }
        }

        if (perfectCourses.length > 0) {
            console.log(chalk.green(`[${getPacificTime()}] [${subject} ${courseNumber}] 发现 ${perfectCourses.length} 个无限制的 ${modeText}${typeText} 选项！`));

            let detailsHtml = perfectCourses.map(c => `
                <li style="margin-bottom: 10px;">
                    <b>CRN:</b> ${c.courseReferenceNumber}<br/>
                    <b>Title:</b> ${c.courseTitle}<br/>
                    <b>Type:</b> ${c.scheduleTypeDescription} (${c.campusDescription})<br/>
                    <b>Seats Available:</b> <span style="color:red; font-weight:bold">${c.seatsAvailable} / ${c.maximumEnrollment}</span><br/>
                    <b>Waitlist Available:</b> <span style="color:red; font-weight:bold">${c.waitAvailable}</span>
                </li>
            `).join("");

            const mailSubject = `发现有空位的 ${subject} ${courseNumber} ${modeText}${typeText}`;
            const body = `
                <h2>${subject} ${courseNumber} 发现了符合 ${typeText} 要求的 ${modeText} 选项</h2>
                <p>以下 Section 符合您的要求，且<b>未检测到 DSC 或 Corvallis 本校区限制</b>：</p>
                <ul>${detailsHtml}</ul>
                <p>请尽快前往 <a href="https://prodapps.isadm.oregonstate.edu/StudentRegistrationSsb/ssb/registration#">OSU 选课系统</a> 完成操作！</p>
            `;
            await sendEmailAlert(courseKey, mailSubject, body);
        }

    } catch (error) {
        console.error(chalk.red(`[${getPacificTime()}] [${subject} ${courseNumber}] 检测出错: ${error.message}`));
    }
}

async function monitorAllCourses() {
    if (Date.now() - lastRefreshTime >= 300_000) {
        console.log(chalk.magenta(`[${getPacificTime()}] 距离上次刷新已达 5 分钟，主动刷新 Session...`));
        await refreshSession();
    }

    console.log(chalk.cyan(`\n--- 开始新一轮全量扫描 (${getPacificTime()}) ---`));
    
    for (const course of COURSES_TO_MONITOR) {
        await checkPerfectSection(course);
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    setTimeout(monitorAllCourses, 15_000);
}

// ================= 交互录入与启动程序 =================
async function setupCoursesInteractively() {
    console.log(chalk.cyan(`\n=== 欢迎使用 OSU 选课监控助手 ===`));

    // 1. 设置全局动态学期
    let termQs = [
        {
            prompt: chalk.yellow("请输入需要监控的年份 (例如 2026): "),
            validate: ans => /^\d{4}$/.test(ans) ? true : (console.log(chalk.red("年份格式错误，请输入 4 位纯数字！")), false)
        },
        {
            prompt: chalk.yellow("请选择学期:\n  [1] Fall (秋季)\n  [2] Winter (冬季)\n  [3] Spring (春季)\n  [4] Summer (夏季)\n请输入选项 (1/2/3/4): "),
            validate: ans => ['1','2','3','4'].includes(ans) ? true : (console.log(chalk.red("无效的选项，请输入 1-4 之间的数字！")), false)
        }
    ];

    console.log(chalk.bgCyan.black(" 【第一步：配置监控学期】 "));
    let termAns = await askWithBack(termQs);
    const termMap = { '1': '01', '2': '02', '3': '03', '4': '04' };
    TERM = termAns[0] + termMap[termAns[1]];
    console.log(chalk.green(`\n✅ 监控学期已锁定为: ${TERM}`));

    // 2. 循环录入课程
    console.log(chalk.bgCyan.black("\n 【第二步：配置监控课程】 "));
    let addMore = true;

    while (addMore) {
        console.log(chalk.bold(`\n[录入第 ${COURSES_TO_MONITOR.length + 1} 门课程]`));
        
        let courseQs = [
            {
                prompt: chalk.yellow("请输入 Subject (例如 CS, MTH): "),
                // 新增：仅允许大小写字母
                validate: ans => /^[A-Za-z]+$/.test(ans) ? true : (console.log(chalk.red("科目缩写错误，只能输入纯字母 (不支持空格或数字)！")), false)
            },
            {
                prompt: chalk.yellow("请输入 Course Number (例如 123, 456): "),
                // 新增：仅允许数字
                validate: ans => /^\d+$/.test(ans) ? true : (console.log(chalk.red("课程号错误，只能输入纯数字！")), false)
            },
            {
                prompt: chalk.yellow("是否只监控网课？(y/n，直接回车默认 y): "),
                validate: ans => {
                    const val = ans.trim().toLowerCase();
                    // 只允许输入为空（默认），或者 y，或者 n
                    if (val === '' || val === 'y' || val === 'n') {
                        return true;
                    } else {
                        console.log(chalk.red("无效的输入，请输入 y 或 n，或者直接回车！"));
                        return false;
                    }
                }
            },
            {
                prompt: chalk.yellow("请选择您想要监控的目标：\n  [1] 仅监控可用座位 (Seat > 0)\n  [2] 仅监控等待队列 (Waitlist > 0)\n  [3] 同时监控 Seat 和 Waitlist (只要任一有空即提醒)\n请输入选项 (1/2/3，直接回车默认 3): "),
                validate: ans => (ans === '' || ['1','2','3'].includes(ans)) ? true : (console.log(chalk.red("无效的选项，请输入 1/2/3 或直接回车！")), false)
            }
        ];

        let courseAns = await askWithBack(courseQs);
        let subject = courseAns[0].toUpperCase();
        let courseNumber = courseAns[1];
        let checkOnlineOnly = courseAns[2].toLowerCase() !== 'n'; // 默认 true，除非明确输入 n
        let monitorMode = courseAns[3] || '3';                    // 默认 3

        COURSES_TO_MONITOR.push({
            subject: subject,
            courseNumber: courseNumber,
            checkOnlineOnly: checkOnlineOnly,
            monitorMode: monitorMode
        });

        console.log(chalk.green(`✅ 成功添加: ${subject} ${courseNumber}`));

        const moreInput = await askQuestion(chalk.green("\n是否继续添加其他监控课程？(y/n，直接回车默认 n): "));
        addMore = moreInput.trim().toLowerCase() === 'y';
    }
}

// ================= 程序入口 =================
(async () => {
    console.log(chalk.blue(`[${getPacificTime()}] 免责提示：本程序仅用于学习和研究目的，请勿用于任何商业或非法用途。`));
    
    // 1. 启动时验证邮箱配置
    let emailOk = await verifyEmailConfig();
    
    if (!emailOk) {
        console.log(chalk.bgRed.white("\n 警告: 邮件配置验证失败 (可能未配置 email_info.env 或账号密码错误) "));
        console.log("请选择后续操作：");
        console.log("  [1] 在【无邮件提醒】的情况下继续运行 (仅在屏幕显示提示)");
        console.log("  [2] 现在设置邮件配置 (将引导您创建/覆盖 .env 文件)");
        console.log("  [3] 退出程序");
        
        while (true) {
            const ans = await askQuestion(chalk.yellow("\n请输入您的选择 (1/2/3): "));
            const choice = ans.trim();
            
            if (choice === '1') {
                enableEmailAlerts = false;
                console.log(chalk.magenta(`\n[${getPacificTime()}] 已选择继续运行。程序检测到空位时将【仅在控制台显示】，不会发送邮件。`));
                break; // 输入正确，跳出循环继续执行后续代码
            } else if (choice === '2') {
                const configSuccess = await configureEnvFile();
                if (configSuccess) {
                    const reVerify = await verifyEmailConfig();
                    if (!reVerify) {
                        console.log(chalk.red(`\n[${getPacificTime()}] 设置后仍然验证失败，程序将退出，请检查您输入的账号和授权码是否正确。`));
                        rl.close();
                        process.exit(1);
                    }
                    break; // 设置且验证成功，跳出循环
                } else {
                    rl.close();
                    process.exit(1);
                }
            } else if (choice === '3') {
                console.log(chalk.red(`\n[${getPacificTime()}] 程序已退出。`));
                rl.close();
                process.exit(0);
            } else {
                // 如果输入的不是 1, 2, 3，则报错并让循环重来
                console.log(chalk.red("无效的选项，请输入 1, 2 或 3！"));
            }
        }
    }

    // 2. 启动交互式引导
    await setupCoursesInteractively();
    rl.close(); 

    if (COURSES_TO_MONITOR.length === 0) {
        console.log(chalk.red("未添加任何课程，程序退出。"));
        return;
    }

    // 3. 正式启动监控
    console.log(chalk.magenta(`\n[${getPacificTime()}] 录入完毕！启动多课程监控，共监控 ${COURSES_TO_MONITOR.length} 门课程...`));
    await refreshSession();
    await monitorAllCourses(); 
})();