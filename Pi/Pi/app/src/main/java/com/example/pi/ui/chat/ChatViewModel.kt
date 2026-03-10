package com.example.pi.ui.chat

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import android.util.Log
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.example.pi.data.local.dao.MessageDao
import com.example.pi.data.local.entity.MessageEntity
import com.example.pi.data.remote.WsClient
import com.example.pi.data.remote.WsMessage
import com.example.pi.data.remote.dto.ImageData
import com.example.pi.data.repository.ChatRepository
import com.example.pi.data.repository.ChatUpdate
import com.example.pi.data.repository.ReceivedFile
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.util.concurrent.atomic.AtomicLong
import javax.inject.Inject

/** Represents a single chat message in the UI */
data class UiMessage(
    val id: Long = UiMessage.nextId(),
    val role: String, // "user", "assistant", "tool"
    val content: String,
    val toolName: String? = null,
    val isStreaming: Boolean = false,
    val imageUris: List<Uri>? = null,
    val receivedFiles: List<ReceivedFile>? = null
) {
    companion object {
        private val counter = AtomicLong(0)
        fun nextId(): Long = counter.getAndIncrement()
    }
}

@HiltViewModel
class ChatViewModel @Inject constructor(
    private val chatRepository: ChatRepository,
    private val wsClient: WsClient,
    private val messageDao: MessageDao,
    @ApplicationContext private val appContext: Context
) : ViewModel() {

    val messages = mutableStateListOf<UiMessage>()
    val isStreaming = mutableStateOf(false)
    val streamingText = mutableStateOf("")
    private val streamingBuffer = StringBuilder()
    private val pendingFiles = mutableListOf<ReceivedFile>()
    private var currentJob: Job? = null
    private var conversationId: String? = null

    // Push message state (from WebSocket events with delivery="message")
    val pushStreamingText = mutableStateOf("")
    private val pushBuffer = StringBuilder()
    private var isPushStreaming = false

    init {
        loadPreviousMessages()
        observePushMessages()
    }

    private fun loadPreviousMessages() {
        viewModelScope.launch {
            val lastConvId = messageDao.getLatestConversationId() ?: return@launch
            conversationId = lastConvId
            val saved = messageDao.getByConversation(lastConvId)
            messages.addAll(saved.map { entity ->
                UiMessage(
                    role = entity.role,
                    content = entity.content,
                    toolName = entity.toolName
                )
            })
        }
    }

    private fun saveMessage(role: String, content: String, toolName: String? = null) {
        val convId = conversationId ?: return
        viewModelScope.launch {
            messageDao.insert(
                MessageEntity(
                    conversationId = convId,
                    role = role,
                    content = content,
                    toolName = toolName
                )
            )
        }
    }

    private fun observePushMessages() {
        viewModelScope.launch {
            wsClient.messages.collect { msg ->
                when (msg) {
                    is WsMessage.EventFired -> {
                        isPushStreaming = true
                        pushBuffer.clear()
                        pushStreamingText.value = ""
                    }

                    is WsMessage.TextDelta -> {
                        if (isPushStreaming) {
                            pushBuffer.append(msg.delta)
                            pushStreamingText.value = pushBuffer.toString()
                        }
                    }

                    is WsMessage.AgentEnd -> {
                        if (isPushStreaming) {
                            val text = pushBuffer.toString().trim()
                            if (text.isNotEmpty() && text != "[SILENT]" && !text.startsWith("[SILENT]")) {
                                messages.add(UiMessage(role = "assistant", content = text))
                                saveMessage("assistant", text)
                            }
                            pushBuffer.clear()
                            pushStreamingText.value = ""
                            isPushStreaming = false
                        }
                    }

                    else -> { }
                }
            }
        }
    }

    fun sendMessage(text: String, imageUris: List<Uri>? = null) {
        if (text.isBlank() && imageUris.isNullOrEmpty()) return
        if (isStreaming.value) return

        val displayText = text.ifBlank { "[图片]" }
        messages.add(UiMessage(role = "user", content = displayText, imageUris = imageUris))
        isStreaming.value = true
        streamingBuffer.clear()
        streamingText.value = ""

        pendingFiles.clear()

        currentJob = viewModelScope.launch {
            // Encode images on IO thread
            val encodedImages = imageUris?.let { uris ->
                withContext(Dispatchers.IO) {
                    uris.mapNotNull { uri -> encodeImage(uri) }
                }
            }

            chatRepository.sendMessage(
                text.ifBlank { "请描述这张图片" },
                conversationId,
                encodedImages?.ifEmpty { null }
            ).collect { update ->
                when (update) {
                    is ChatUpdate.TextDelta -> {
                        streamingBuffer.append(update.delta)
                        streamingText.value = streamingBuffer.toString()
                    }
                    is ChatUpdate.ToolCallStart -> {
                        messages.add(
                            UiMessage(
                                role = "tool",
                                content = "",
                                toolName = update.toolName
                            )
                        )
                    }
                    is ChatUpdate.ToolCallEnd -> { }
                    is ChatUpdate.ToolResult -> {
                        val idx = messages.indexOfLast { it.role == "tool" && it.toolName == update.toolName }
                        if (idx >= 0) {
                            messages[idx] = messages[idx].copy(
                                content = update.result
                            )
                        }
                    }
                    is ChatUpdate.ConversationId -> {
                        conversationId = update.id
                        saveMessage("user", displayText)
                    }
                    is ChatUpdate.FileReceived -> {
                        pendingFiles.add(update.file)
                    }
                    is ChatUpdate.StreamStart -> { }
                    is ChatUpdate.StreamEnd -> {
                        val finalText = streamingBuffer.toString()
                        val files = pendingFiles.toList()
                        if (finalText.isNotBlank() || files.isNotEmpty()) {
                            messages.add(
                                UiMessage(
                                    role = "assistant",
                                    content = finalText,
                                    receivedFiles = files.ifEmpty { null }
                                )
                            )
                            saveMessage("assistant", finalText)
                        }
                        pendingFiles.clear()
                        streamingBuffer.clear()
                        streamingText.value = ""
                        isStreaming.value = false
                    }
                    is ChatUpdate.StreamError -> {
                        val finalText = streamingBuffer.toString()
                        if (finalText.isNotBlank()) {
                            messages.add(
                                UiMessage(role = "assistant", content = finalText)
                            )
                            saveMessage("assistant", finalText)
                        }
                        messages.add(
                            UiMessage(role = "assistant", content = "Error: ${update.message}")
                        )
                        streamingBuffer.clear()
                        streamingText.value = ""
                        isStreaming.value = false
                    }
                }
            }
        }
    }

    private fun encodeImage(uri: Uri): ImageData? {
        return try {
            val inputStream = appContext.contentResolver.openInputStream(uri) ?: return null
            val original = BitmapFactory.decodeStream(inputStream)
            inputStream.close()

            val maxDim = 1024
            val scaled = if (original.width > maxDim || original.height > maxDim) {
                val ratio = minOf(maxDim.toFloat() / original.width, maxDim.toFloat() / original.height)
                val newW = (original.width * ratio).toInt()
                val newH = (original.height * ratio).toInt()
                Bitmap.createScaledBitmap(original, newW, newH, true).also {
                    if (it !== original) original.recycle()
                }
            } else {
                original
            }

            val baos = ByteArrayOutputStream()
            scaled.compress(Bitmap.CompressFormat.JPEG, 85, baos)
            scaled.recycle()
            val base64 = Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP)
            baos.close()

            ImageData(mimeType = "image/jpeg", data = base64)
        } catch (e: Exception) {
            Log.e("ChatViewModel", "Failed to encode image: $uri", e)
            null
        }
    }

    fun clearChat() {
        currentJob?.cancel()
        val convId = conversationId
        messages.clear()
        streamingBuffer.clear()
        streamingText.value = ""
        pushBuffer.clear()
        pushStreamingText.value = ""
        isStreaming.value = false
        isPushStreaming = false
        conversationId = null
        if (convId != null) {
            viewModelScope.launch { messageDao.deleteByConversation(convId) }
        }
    }
}
