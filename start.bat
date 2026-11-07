@echo off
chcp 65001 >nul
setlocal
rem MD Görüntüleyici başlatıcı
rem Kullanım: start.bat [dosya1.md] [dosya2.md] ...

where node >nul 2>nul
if errorlevel 1 goto nonode

title MD Görüntüleyici
node "%~dp0server.js" %*
if errorlevel 1 pause
goto :eof

:nonode
echo Node.js bulunamadı; sunucusuz modda (file://) açılıyor.
echo Bu modda dosyaları sürükle-bırak veya "Dosya aç" ile açın.
start "" "%~dp0index.html"
