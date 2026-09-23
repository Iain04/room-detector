/*
 * CSI sender: broadcasts small ESP-NOW frames at a fixed rate on a fixed
 * Wi-Fi channel so a receiver ESP32 can measure Channel State Information.
 *
 * Based on the design of Espressif's esp-csi "csi_send" example.
 */
#include <stdio.h>
#include <string.h>
#include <inttypes.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_err.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "esp_now.h"
#include "esp_mac.h"
#include "esp_timer.h"
#include "nvs_flash.h"

#define CSI_MAGIC 0x43534931u /* "CSI1" */

static const char *TAG = "csi_sender";
static const uint8_t BROADCAST_MAC[ESP_NOW_ETH_ALEN] = {0xff, 0xff, 0xff, 0xff, 0xff, 0xff};

typedef struct __attribute__((packed)) {
    uint32_t magic;
    uint32_t seq;
    int64_t uptime_us;
} csi_ping_header_t;

#if CONFIG_CSI_SEND_USE_CUSTOM_MAC
static bool parse_mac(const char *str, uint8_t out[6])
{
    unsigned int b[6];
    if (sscanf(str, "%x:%x:%x:%x:%x:%x", &b[0], &b[1], &b[2], &b[3], &b[4], &b[5]) != 6) {
        return false;
    }
    for (int i = 0; i < 6; i++) {
        if (b[i] > 0xff) {
            return false;
        }
        out[i] = (uint8_t)b[i];
    }
    return (out[0] & 0x01) == 0; /* must be unicast */
}
#endif

static void wifi_init(void)
{
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));

#if CONFIG_CSI_SEND_USE_CUSTOM_MAC
    uint8_t custom_mac[6];
    if (parse_mac(CONFIG_CSI_SEND_CUSTOM_MAC, custom_mac)) {
        ESP_ERROR_CHECK(esp_wifi_set_mac(WIFI_IF_STA, custom_mac));
    } else {
        ESP_LOGE(TAG, "Invalid custom MAC '%s', using factory MAC", CONFIG_CSI_SEND_CUSTOM_MAC);
    }
#endif

    ESP_ERROR_CHECK(esp_wifi_start());
    /* Never sleep: we want a steady transmit rate. */
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));
    ESP_ERROR_CHECK(esp_wifi_set_channel(CONFIG_CSI_SEND_CHANNEL, WIFI_SECOND_CHAN_NONE));
}

static void espnow_init(void)
{
    ESP_ERROR_CHECK(esp_now_init());

    esp_now_peer_info_t peer = {
        .channel = CONFIG_CSI_SEND_CHANNEL,
        .ifidx = WIFI_IF_STA,
        .encrypt = false,
    };
    memcpy(peer.peer_addr, BROADCAST_MAC, ESP_NOW_ETH_ALEN);
    ESP_ERROR_CHECK(esp_now_add_peer(&peer));
}

static void send_task(void *arg)
{
    uint8_t payload[CONFIG_CSI_SEND_PAYLOAD_LEN];
    memset(payload, 0, sizeof(payload));
    csi_ping_header_t *hdr = (csi_ping_header_t *)payload;
    hdr->magic = CSI_MAGIC;

    TickType_t period = pdMS_TO_TICKS(1000 / CONFIG_CSI_SEND_FREQUENCY_HZ);
    if (period == 0) {
        period = 1;
    }

    uint32_t sent = 0;
    uint32_t failed = 0;
    int64_t last_stats_us = esp_timer_get_time();
    TickType_t last_wake = xTaskGetTickCount();

    for (;;) {
        hdr->seq++;
        hdr->uptime_us = esp_timer_get_time();

        esp_err_t err = esp_now_send(BROADCAST_MAC, payload, sizeof(payload));
        if (err == ESP_OK) {
            sent++;
        } else {
            failed++;
        }

        int64_t now_us = esp_timer_get_time();
        if (now_us - last_stats_us >= (int64_t)CONFIG_CSI_SEND_STATS_INTERVAL_S * 1000000) {
            float secs = (now_us - last_stats_us) / 1e6f;
            ESP_LOGI(TAG, "seq=%" PRIu32 " rate=%.1f pkt/s failed=%" PRIu32,
                     hdr->seq, sent / secs, failed);
            sent = 0;
            failed = 0;
            last_stats_us = now_us;
        }

        xTaskDelayUntil(&last_wake, period);
    }
}

void app_main(void)
{
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    wifi_init();
    espnow_init();

    uint8_t mac[6];
    ESP_ERROR_CHECK(esp_wifi_get_mac(WIFI_IF_STA, mac));
    ESP_LOGI(TAG, "==================================================");
    ESP_LOGI(TAG, "SENDER MAC: " MACSTR "  <- put this in receiver menuconfig", MAC2STR(mac));
    ESP_LOGI(TAG, "Channel: %d  Rate: %d Hz", CONFIG_CSI_SEND_CHANNEL, CONFIG_CSI_SEND_FREQUENCY_HZ);
    ESP_LOGI(TAG, "==================================================");

    xTaskCreate(send_task, "csi_send", 4096, NULL, 5, NULL);
}
