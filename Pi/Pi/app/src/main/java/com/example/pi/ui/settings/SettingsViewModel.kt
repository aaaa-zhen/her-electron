package com.example.pi.ui.settings

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.mutableStateOf
import androidx.core.content.FileProvider
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.example.pi.BuildConfig
import com.example.pi.data.local.ServerUrlManager
import com.example.pi.data.remote.WsClient
import com.example.pi.data.repository.MemoryRepository
import com.example.pi.data.repository.ReminderRepository
import com.google.gson.Gson
import com.google.gson.JsonObject
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import javax.inject.Inject

data class UpdateInfo(
    val versionCode: Int,
    val versionName: String,
    val downloadUrl: String,
    val changelog: String
)

@HiltViewModel
class SettingsViewModel @Inject constructor(
    private val serverUrlManager: ServerUrlManager,
    private val memoryRepository: MemoryRepository,
    private val reminderRepository: ReminderRepository,
    private val wsClient: WsClient,
    private val okHttpClient: OkHttpClient,
    private val gson: Gson
) : ViewModel() {

    val statusMessage = mutableStateOf("")

    val updateInfo = mutableStateOf<UpdateInfo?>(null)
    val updateCheckMessage = mutableStateOf("")
    val downloadProgress = mutableStateOf(-1) // -1 = not downloading, 0-100 = progress

    // Pairing state
    val isPaired = mutableStateOf(false)
    val pairedDeviceName = mutableStateOf("")
    val agentConnected = mutableStateOf(false)

    init {
        viewModelScope.launch {
            refreshPairState()
        }
        // Observe agent status from relay
        viewModelScope.launch {
            wsClient.messages.collect { msg ->
                if (msg is com.example.pi.data.remote.WsMessage.AgentStatus) {
                    agentConnected.value = msg.connected
                    if (msg.deviceName.isNotBlank()) {
                        pairedDeviceName.value = msg.deviceName
                    }
                }
            }
        }
    }

    private suspend fun refreshPairState() {
        isPaired.value = serverUrlManager.isPaired()
        pairedDeviceName.value = serverUrlManager.getRelayName()
    }

    fun onPairScanned(relayUrl: String, token: String, name: String) {
        viewModelScope.launch {
            serverUrlManager.savePairing(relayUrl, token, name)
            isPaired.value = true
            pairedDeviceName.value = name
            statusMessage.value = "已配对: $name"
            // Reconnect WsClient to relay
            wsClient.connect()
        }
    }

    fun unpair() {
        viewModelScope.launch {
            wsClient.disconnect()
            serverUrlManager.clearPairing()
            isPaired.value = false
            pairedDeviceName.value = ""
            agentConnected.value = false
            statusMessage.value = "已断开配对"
            // Reconnect to direct server
            wsClient.connect()
        }
    }

    fun checkUpdate() {
        updateCheckMessage.value = "正在检查..."
        updateInfo.value = null
        viewModelScope.launch {
            try {
                val result = withContext(Dispatchers.IO) {
                    val request = Request.Builder()
                        .url("${ServerUrlManager.BASE_URL}/api/version")
                        .get()
                        .build()
                    okHttpClient.newCall(request).execute().use { response ->
                        if (response.isSuccessful) response.body?.string() else null
                    }
                }
                if (result != null) {
                    val json = gson.fromJson(result, JsonObject::class.java)
                    val remoteCode = json.get("versionCode")?.asInt ?: 0
                    val remoteName = json.get("versionName")?.asString ?: ""
                    val downloadUrl = json.get("downloadUrl")?.asString ?: ""
                    val changelog = json.get("changelog")?.asString ?: ""

                    if (remoteCode > BuildConfig.VERSION_CODE) {
                        updateInfo.value = UpdateInfo(remoteCode, remoteName, downloadUrl, changelog)
                        updateCheckMessage.value = ""
                    } else {
                        updateCheckMessage.value = "已是最新版本"
                    }
                } else {
                    updateCheckMessage.value = "检查失败"
                }
            } catch (_: Exception) {
                updateCheckMessage.value = "检查失败，请检查网络"
            }
        }
    }

    fun downloadAndInstall(context: Context) {
        val info = updateInfo.value ?: return
        downloadProgress.value = 0
        viewModelScope.launch {
            try {
                val apkFile = withContext(Dispatchers.IO) {
                    val request = Request.Builder().url(info.downloadUrl).build()
                    okHttpClient.newCall(request).execute().use { response ->
                        if (!response.isSuccessful) return@withContext null
                        val body = response.body ?: return@withContext null
                        val contentLength = body.contentLength()
                        val dir = context.getExternalFilesDir("apk")
                            ?: return@withContext null
                        dir.mkdirs()
                        val file = File(dir, "pi-update.apk")
                        file.outputStream().use { output ->
                            val buffer = ByteArray(8192)
                            var bytesRead: Long = 0
                            val input = body.byteStream()
                            while (true) {
                                val read = input.read(buffer)
                                if (read == -1) break
                                output.write(buffer, 0, read)
                                bytesRead += read
                                if (contentLength > 0) {
                                    downloadProgress.value =
                                        (bytesRead * 100 / contentLength).toInt()
                                }
                            }
                        }
                        file
                    }
                }
                downloadProgress.value = -1
                if (apkFile != null) {
                    installApk(context, apkFile)
                } else {
                    updateCheckMessage.value = "下载失败"
                }
            } catch (_: Exception) {
                downloadProgress.value = -1
                updateCheckMessage.value = "下载失败，请检查网络"
            }
        }
    }

    private fun installApk(context: Context, file: File) {
        val uri: Uri = FileProvider.getUriForFile(
            context,
            "${context.packageName}.fileprovider",
            file
        )
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION
        }
        context.startActivity(intent)
    }
}
