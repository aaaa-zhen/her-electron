package com.example.pi.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import com.example.pi.BuildConfig
import com.example.pi.R
import com.example.pi.ui.theme.Accent
import com.example.pi.ui.theme.AccentDim
import com.example.pi.ui.theme.AccentSurface
import com.example.pi.ui.theme.Background
import com.example.pi.ui.theme.TextPrimary
import com.example.pi.ui.theme.TextSecondary

@Composable
fun SettingsScreen(
    onBack: () -> Unit,
    viewModel: SettingsViewModel = hiltViewModel()
) {
    val statusMessage by viewModel.statusMessage
    val updateInfo by viewModel.updateInfo
    val updateCheckMessage by viewModel.updateCheckMessage
    val downloadProgress by viewModel.downloadProgress
    val context = LocalContext.current

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Background)
    ) {
        // Top bar
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 8.dp, end = 20.dp, top = 14.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            IconButton(onClick = onBack, modifier = Modifier.size(38.dp)) {
                Icon(
                    painter = painterResource(R.drawable.arrow_up),
                    contentDescription = "Back",
                    tint = TextSecondary,
                    modifier = Modifier.size(22.dp)
                )
            }

            Spacer(modifier = Modifier.weight(1f))

            Text(
                text = "设置",
                fontSize = 17.sp,
                fontWeight = FontWeight.Bold,
                color = TextPrimary,
                letterSpacing = (-0.2).sp
            )

            Spacer(modifier = Modifier.weight(1f))
            Spacer(modifier = Modifier.size(38.dp))
        }

        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 24.dp, vertical = 20.dp)
                .verticalScroll(rememberScrollState())
        ) {
            if (statusMessage.isNotBlank()) {
                Text(
                    text = statusMessage,
                    fontSize = 14.sp,
                    color = Accent
                )
                Spacer(modifier = Modifier.height(16.dp))
            }

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
