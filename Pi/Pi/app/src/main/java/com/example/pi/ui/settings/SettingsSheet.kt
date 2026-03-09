package com.example.pi.ui.settings

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.hilt.navigation.compose.hiltViewModel
import com.example.pi.BuildConfig
import com.example.pi.ui.theme.Accent
import com.example.pi.ui.theme.AccentDim
import com.example.pi.ui.theme.AccentSurface
import com.example.pi.ui.theme.CardBg
import com.example.pi.ui.theme.TextPrimary
import com.example.pi.ui.theme.TextSecondary
import com.example.pi.ui.theme.TextTertiary
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

@Composable
fun SettingsDialog(
    onDismiss: () -> Unit,
    viewModel: SettingsViewModel = hiltViewModel()
) {
    val statusMessage by viewModel.statusMessage
    val updateInfo by viewModel.updateInfo
    val updateCheckMessage by viewModel.updateCheckMessage
    val downloadProgress by viewModel.downloadProgress
    val isPaired by viewModel.isPaired
    val pairedDeviceName by viewModel.pairedDeviceName
    val agentConnected by viewModel.agentConnected
    val context = LocalContext.current

    // QR scanner launcher
    val scanLauncher = rememberLauncherForActivityResult(ScanContract()) { result ->
        if (result.contents != null) {
            try {
                val json = Gson().fromJson(result.contents, JsonObject::class.java)
                val relay = json.get("relay")?.asString ?: ""
                val token = json.get("token")?.asString ?: ""
                val name = json.get("name")?.asString ?: ""
                if (relay.isNotBlank() && token.isNotBlank()) {
                    viewModel.onPairScanned(relay, token, name)
                }
            } catch (_: Exception) {
                viewModel.statusMessage.value = "无效的二维码"
            }
        }
    }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false)
    ) {
        Surface(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 28.dp),
            shape = RoundedCornerShape(20.dp),
            color = CardBg,
            tonalElevation = 6.dp,
            shadowElevation = 8.dp
        ) {
            Column(
                modifier = Modifier
                    .padding(24.dp)
                    .verticalScroll(rememberScrollState())
            ) {
                Text(
                    text = "设置",
                    fontSize = 20.sp,
                    fontWeight = FontWeight.Bold,
                    color = TextPrimary
                )

                Spacer(modifier = Modifier.height(20.dp))

                // ── 电脑连接 ──
                Text(
                    text = "电脑连接",
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = TextSecondary
                )
                Spacer(modifier = Modifier.height(6.dp))

                if (isPaired) {
                    // Show paired state
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Box(
                            modifier = Modifier
                                .size(8.dp)
                                .clip(CircleShape)
                                .background(if (agentConnected) Color(0xFF4ADE80) else Color(0xFF585858))
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            text = if (agentConnected) "已连接: $pairedDeviceName" else "已配对: $pairedDeviceName (离线)",
                            fontSize = 14.sp,
                            color = if (agentConnected) TextPrimary else TextSecondary
                        )
                    }
                    Spacer(modifier = Modifier.height(10.dp))
                    Button(
                        onClick = { viewModel.unpair() },
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(12.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = Color(0xFF2A1A1A),
                            contentColor = Color(0xFFF87171)
                        )
                    ) {
                        Text("断开配对", fontWeight = FontWeight.SemiBold)
                    }
                } else {
                    Text(
                        text = "扫描电脑端 Her 生成的二维码，远程聊天",
                        fontSize = 12.sp,
                        color = TextTertiary
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    Button(
                        onClick = {
                            val options = ScanOptions().apply {
                                setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                                setPrompt("扫描 Her 桌面端的连接二维码")
                                setBeepEnabled(false)
                                setOrientationLocked(true)
                            }
                            scanLauncher.launch(options)
                        },
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(12.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = Accent,
                            contentColor = Color(0xFF0C0C0C)
                        )
                    ) {
                        Text("扫码连接", fontWeight = FontWeight.SemiBold)
                    }
                }

                if (statusMessage.isNotBlank()) {
                    Spacer(modifier = Modifier.height(12.dp))
                    Text(
                        text = statusMessage,
                        fontSize = 14.sp,
                        color = Accent
                    )
                }

                Spacer(modifier = Modifier.height(24.dp))

                // 关于
                Text(
                    text = "关于",
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = TextSecondary
                )
                Spacer(modifier = Modifier.height(10.dp))

                Text(
                    text = "当前版本: ${BuildConfig.VERSION_NAME}",
                    fontSize = 14.sp,
                    color = TextSecondary
                )

                Spacer(modifier = Modifier.height(10.dp))

                if (updateInfo != null) {
                    Text(
                        text = "新版本: ${updateInfo!!.versionName}",
                        fontSize = 14.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = AccentDim
                    )
                    if (updateInfo!!.changelog.isNotBlank()) {
                        Spacer(modifier = Modifier.height(4.dp))
                        Text(
                            text = updateInfo!!.changelog,
                            fontSize = 12.sp,
                            color = TextSecondary
                        )
                    }
                    Spacer(modifier = Modifier.height(8.dp))

                    if (downloadProgress >= 0) {
                        LinearProgressIndicator(
                            progress = { downloadProgress / 100f },
                            modifier = Modifier.fillMaxWidth(),
                            color = Accent,
                            trackColor = AccentSurface
                        )
                        Spacer(modifier = Modifier.height(4.dp))
                        Text(
                            text = "下载中 $downloadProgress%",
                            fontSize = 12.sp,
                            color = TextSecondary
                        )
                    } else {
                        Button(
                            onClick = { viewModel.downloadAndInstall(context) },
                            modifier = Modifier.fillMaxWidth(),
                            shape = RoundedCornerShape(12.dp),
                            colors = ButtonDefaults.buttonColors(
                                containerColor = Accent,
                                contentColor = Color(0xFF0C0C0C)
                            )
                        ) {
                            Text("下载更新", fontWeight = FontWeight.SemiBold)
                        }
                    }
                } else {
                    Button(
                        onClick = { viewModel.checkUpdate() },
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(12.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = AccentSurface,
                            contentColor = Accent
                        )
                    ) {
                        Text("检查更新", fontWeight = FontWeight.SemiBold)
                    }
                }

                if (updateCheckMessage.isNotBlank()) {
                    Spacer(modifier = Modifier.height(6.dp))
                    Text(
                        text = updateCheckMessage,
                        fontSize = 12.sp,
                        color = TextSecondary
                    )
                }
            }
        }
    }
}
