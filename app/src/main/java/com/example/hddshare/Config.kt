package com.example.hddshare

object Config {
    /** Sunucu portu */
    val PORT = 8080

    /** Şifre koymak istersen ikisini de doldur. PASSWORD boşsa şifresiz çalışır. */
    val USERNAME = ""
    val PASSWORD = ""

    /** true: CPU'yu uyanık tutar (stick uykuya geçince paylaşım kopmasın). Sadece disk takılıyken aktif. */
    val KEEP_CPU_AWAKE = true

    /** Diskin takılı olup olmadığı bu aralıkla kontrol edilir (ms). */
    val CHECK_INTERVAL_MS = 5000L
}
