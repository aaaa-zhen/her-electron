package com.example.pi

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import com.example.pi.R
import dagger.hilt.android.HiltAndroidApp

@HiltAndroidApp
class HerApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    private fun createNotificationChannel() {
        val manager = getSystemService(NotificationManager::class.java)

        val reminderChannel = NotificationChannel(
            REMINDER_CHANNEL_ID,
            getString(R.string.notification_channel_name_reminders),
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = getString(R.string.notification_channel_desc_reminders)
        }
        manager.createNotificationChannel(reminderChannel)

        val serviceChannel = NotificationChannel(
            SERVICE_CHANNEL_ID,
            getString(R.string.notification_channel_name_service),
            NotificationManager.IMPORTANCE_MIN
        ).apply {
            description = getString(R.string.notification_channel_desc_service)
            setShowBadge(false)
        }
        manager.createNotificationChannel(serviceChannel)
    }

    companion object {
        const val REMINDER_CHANNEL_ID = "her_reminders_v2"
        const val SERVICE_CHANNEL_ID = "her_service"
    }
}
