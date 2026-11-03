@echo off
cd /d "C:\Users\www34\Desktop\???"
set ANDROID_HOME=C:\Users\www34\Desktop\???\android-sdk
set ANDROID_SDK_ROOT=%ANDROID_HOME%
set ANDROID_USER_HOME=C:\Users\www34\Desktop\???\home\.android
set ANDROID_AVD_HOME=C:\Users\www34\Desktop\???\avd
set ADB_VENDOR_KEYS=C:\Users\www34\Desktop\???\home\.android
set TEMP=C:\Users\www34\Desktop\???\home\adbhome
set TMP=%TEMP%
"C:\Users\www34\Desktop\???\android-sdk\emulator\emulator.exe" -avd A14_Play -no-window -no-audio -no-snapshot -no-boot-anim -gpu swiftshader_indirect -port 5554 -no-metrics -writable-system > "C:\Users\www34\Desktop\???\_logs\em5.log" 2>&1
