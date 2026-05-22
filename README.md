# ChatGPT-Auto-Reg

Du an nay la mot ung dung Node.js + Express + Playwright + SQLite de:
- quan ly danh sach account
- chay flow dang ky / dang nhap ChatGPT
- lay OTP tu mail
- luu session sau khi tao account thanh cong

## 1. Yeu cau can cai truoc

Can cai san cac thanh phan sau:
- Node.js 18+ (khuyen nghi Node.js 20 hoac moi hon)
- npm
- Windows / macOS / Linux
- Ket noi internet on dinh

Kiem tra nhanh:

```bash
node -v
npm -v
```

## 2. Cai dat du an

Mo terminal trong thu muc project, sau do chay:

```bash
npm install
```

Sau khi cai package xong, cai browser cho Playwright:

```bash
npx playwright install chromium
```

Neu may chua co day du system dependency cua Playwright, co the chay them:

```bash
npx playwright install
```

## 3. Thu muc va file quan trong

- `server.js`: backend Express + Playwright flow
- `index.html`: giao dien UI quan ly list account
- `data.db`: database SQLite luu list, account, code, session
- `package.json`: thong tin package va lenh chay

## 4. Cach chay du an

Chay server:

```bash
npm start
```

Neu port `3000` dang bi chiem, app se tu dong nhay sang port khac nhu `3001`, `3002`...

Sau khi chay, terminal se in ra URL dang dung, vi du:

```bash
Server running at http://localhost:3000
```

hoac:

```bash
Server running at http://localhost:3001 (port 3000 ban, tu chuyen sang 3001)
```

Mo trinh duyet va vao dung URL do.

## 5. Cach su dung UI

### Tao danh sach
- Nhap ten danh sach
- Bam `Tao danh sach`

### Import account
Paste theo format moi dong 1 account:

```text
email|password|refresh_token|client_id
```

Vi du:

```text
a@example.com|matkhau123|refresh_token_here|client_id_here
b@example.com|matkhau456|refresh_token_here|client_id_here
```

Sau do bam:
- `Import vao danh sach dang chon`

### Chay tung account
- Chon account trong list
- Bam `Run OpenAI`

### Chay toan bo account trong 1 list
- Chon list
- Bam `Run tat ca tai khoan trong list`

Flow se chay lan luot tung account, khong chay song song.

## 6. Session va OTP

Du an hien tai ho tro:
- lay OTP moi tu mail
- dien OTP vao form
- dien `Full name`
- dien `Age`
- bam `Finish creating account`
- doi 30 giay
- vao `https://chatgpt.com/api/auth/session`
- luu session da convert vao DB

Trong UI co:
- `Saved Session`: session cua account dang chon
- `Saved Session List`: tong hop session cua toan bo account da co session trong list dang chon
- `Copy Sessions`: copy mang session cua list
- `Export Sessions JSON`: tai file JSON session cua list

## 7. Database

Du lieu duoc luu trong file:

```text
data.db
```

Neu ban xoa file nay, du lieu list/account/session se mat.

Nen backup file nay neu du lieu quan trong.

## 8. Neu gap loi khong chay duoc

### Truong hop port 3000 dang bi chiem
Kiem tra process dang dung port 3000:

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen
```

App da co co che tu nhay port khac, nhung ban van nen mo dung URL in ra trong terminal.

### Truong hop chua cai browser Playwright
Chay:

```bash
npx playwright install chromium
```

### Truong hop loi package
Xoa `node_modules` va cai lai:

```bash
rm -rf node_modules
npm install
npx playwright install chromium
```

Tren Windows PowerShell:

```powershell
Remove-Item -Recurse -Force node_modules
npm install
npx playwright install chromium
```

## 9. Lenh nhanh

Cai package:

```bash
npm install
```

Cai browser Playwright:

```bash
npx playwright install chromium
```

Chay du an:

```bash
npm start
```

## 10. Ghi chu

- Du an nay dang toi uu cho moi truong Windows.
- `data.db` dang duoc commit trong repo hien tai.
- `node_modules` cung dang co trong repo hien tai do da duoc push day du theo yeu cau backup.
