package com.example.pi.di

import android.content.Context
import androidx.room.Room
import com.example.pi.data.local.MIGRATION_1_2
import com.example.pi.data.local.PiDatabase
import com.example.pi.data.local.ServerUrlManager
import com.example.pi.data.local.dao.MemoryDao
import com.example.pi.data.local.dao.MessageDao
import com.example.pi.data.local.dao.ReminderDao
import com.google.gson.Gson
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit
import javax.inject.Qualifier
import javax.inject.Singleton

@Qualifier
@Retention(AnnotationRetention.BINARY)
annotation class ApplicationScope

@Module
@InstallIn(SingletonComponent::class)
object AppModule {

    @Provides
    @Singleton
    fun provideOkHttpClient(serverUrlManager: ServerUrlManager): OkHttpClient {
        val authInterceptor = Interceptor { chain ->
            val (apiKey, deviceId) = runBlocking {
                serverUrlManager.getApiKey() to serverUrlManager.getDeviceId()
            }
            val request = chain.request().newBuilder()
                .header("X-Api-Key", apiKey)
                .header("X-Device-Id", deviceId)
                .build()
            chain.proceed(request)
        }
        return OkHttpClient.Builder()
            .addInterceptor(authInterceptor)
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(5, TimeUnit.MINUTES)
            .writeTimeout(30, TimeUnit.SECONDS)
            .build()
    }

    @Provides
    @Singleton
    fun provideGson(): Gson = Gson()

    @Provides
    @Singleton
    @ApplicationScope
    fun provideApplicationScope(): CoroutineScope =
        CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @Provides
    @Singleton
    fun provideDatabase(@ApplicationContext context: Context): PiDatabase {
        return Room.databaseBuilder(
            context,
            PiDatabase::class.java,
            "pi_database"
        )
            .addMigrations(MIGRATION_1_2)
            .build()
    }

    @Provides
    fun provideMemoryDao(db: PiDatabase): MemoryDao = db.memoryDao()

    @Provides
    fun provideReminderDao(db: PiDatabase): ReminderDao = db.reminderDao()

    @Provides
    fun provideMessageDao(db: PiDatabase): MessageDao = db.messageDao()
}
