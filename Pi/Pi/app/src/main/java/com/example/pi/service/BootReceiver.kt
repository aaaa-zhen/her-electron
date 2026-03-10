package com.example.pi.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.example.pi.data.local.dao.ReminderDao
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import javax.inject.Inject

@AndroidEntryPoint
class BootReceiver : BroadcastReceiver() {

    @Inject
    lateinit var reminderDao: ReminderDao

    @Inject
    lateinit var scheduler: ReminderScheduler

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return

        val pendingResult = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val now = System.currentTimeMillis()
                val pending = reminderDao.getPending()
                for (reminder in pending) {
                    if (reminder.triggerAt > now) {
                        scheduler.schedule(reminder)
                    } else {
                        reminderDao.updateStatus(reminder.id, "fired")
                    }
                }
            } finally {
                pendingResult.finish()
            }
        }
    }
}
