package com.example.pi.service

import android.Manifest
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.example.pi.HerApplication
import com.example.pi.R
import com.example.pi.data.remote.WsClient
import com.example.pi.data.remote.WsMessage
import com.example.pi.data.repository.ToolExecutor
import com.google.gson.Gson
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import javax.inject.Inject

@AndroidEntryPoint
class HerWebSocketService : Service() {

    @Inject lateinit var wsClient: WsClient
    @Inject lateinit var toolExecutor: ToolExecutor
    @Inject lateinit var gson: Gson

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var currentEventText = StringBuilder()
    private var currentDelivery = "notification"
    private var notificationCounter = 1000

    override fun onCreate() {
        super.onCreate()
        startForegroundNotification()
        connectAndListen()
    }

    private fun startForegroundNotification() {
        val notification = NotificationCompat.Builder(this, HerApplication.SERVICE_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(getString(R.string.notification_foreground_title))
            .setContentText(getString(R.string.notification_foreground_text))
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .build()
        startForeground(1, notification)
    }

    private fun connectAndListen() {
        scope.launch {
            wsClient.connect()
        }

        scope.launch {
            wsClient.messages.collect { msg ->
                handleMessage(msg)
            }
        }

        scope.launch {
            wsClient.connectionState.collect { connected ->
                if (!connected) {
                    delay(1000)
                    if (!wsClient.connectionState.value) {
                        val backoffMs = wsClient.reconnectIfNeeded()
                        if (backoffMs > 0) {
                            delay(backoffMs)
                        }
                    }
                }
            }
        }
    }

    private suspend fun handleMessage(msg: WsMessage) {
        when (msg) {
            is WsMessage.EventFired -> {
                currentEventText.clear()
                currentDelivery = msg.delivery
                Log.d("HerWsService", "Event fired: ${msg.eventId} - ${msg.text} (delivery=${msg.delivery})")
            }

            is WsMessage.TextDelta -> {
                currentEventText.append(msg.delta)
            }

            is WsMessage.AgentEnd -> {
                val text = currentEventText.toString().trim()
                if (
                    currentDelivery == "notification" &&
                    text.isNotEmpty() &&
                    text != "[SILENT]" &&
                    !text.startsWith("[SILENT]")
                ) {
                    showNotification(text)
                }
                currentEventText.clear()
                currentDelivery = "notification"
            }

            is WsMessage.ClientToolRequest -> {
                val result = try {
                    toolExecutor.execute(msg.toolName, msg.args)
                } catch (e: Exception) {
                    "Error: ${e.message}"
                }
                val response = mapOf(
                    "type" to "tool_result",
                    "toolCallId" to msg.toolCallId,
                    "content" to listOf(mapOf("type" to "text", "text" to result))
                )
                wsClient.send(gson.toJson(response))
            }

            is WsMessage.Connected -> {
                Log.d("HerWsService", "WebSocket connected")
            }

            // Relay messages — handled by ChatRepository/SettingsViewModel, not here
            is WsMessage.AgentStatus,
            is WsMessage.RelayChatStream,
            is WsMessage.RelayChatResponse,
            is WsMessage.RelayJobError -> { }
        }
    }

    private fun showNotification(text: String) {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) return

        val notification = NotificationCompat.Builder(this, HerApplication.REMINDER_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(getString(R.string.notification_chat_title))
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .build()

        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(notificationCounter++ % 10000 + 1000, notification)
    }

    override fun onDestroy() {
        super.onDestroy()
        wsClient.disconnect()
        scope.cancel()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        fun start(context: Context) {
            val intent = Intent(context, HerWebSocketService::class.java)
            ContextCompat.startForegroundService(context, intent)
        }

        fun stop(context: Context) {
            val intent = Intent(context, HerWebSocketService::class.java)
            context.stopService(intent)
        }
    }
}
