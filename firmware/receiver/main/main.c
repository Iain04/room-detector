/*
 * CSI receiver: joins Wi-Fi, syncs time, measures CSI (from the router or a
 * sender board) and publishes 1-second motion features over MQTT.
 *
 * This firmware never decides occupancy - that logic lives in the backend.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <inttypes.h>
#include <sys/time.h>
#include <time.h>

#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "mqtt_client.h"
#include "nvs_flash.h"
#include "ping/ping_sock.h"

#include "csi_processor.h"
#include "env_config.h"

/* Each setting comes from .env if present there, otherwise from menuconfig. */
#ifdef ENV_WIFI_SSID
#define WIFI_SSID ENV_WIFI_SSID
#else
#define WIFI_SSID CONFIG_CSI_WIFI_SSID
#endif
#ifdef ENV_WIFI_PASSWORD
#define WIFI_PASSWORD ENV_WIFI_PASSWORD
#else
#define WIFI_PASSWORD CONFIG_CSI_WIFI_PASSWORD
#endif
#ifdef ENV_MQTT_BROKER_URL
#define MQTT_BROKER_URL ENV_MQTT_BROKER_URL
#else
#define MQTT_BROKER_URL CONFIG_CSI_MQTT_BROKER_URL
#endif
#ifdef ENV_MQTT_USERNAME
#define MQTT_USERNAME ENV_MQTT_USERNAME
#else
#define MQTT_USERNAME CONFIG_CSI_MQTT_USERNAME
#endif
#ifdef ENV_MQTT_PASSWORD
#define MQTT_PASSWORD ENV_MQTT_PASSWORD
#else
#define MQTT_PASSWORD CONFIG_CSI_MQTT_PASSWORD
#endif
#ifdef ENV_MQTT_TELEMETRY_TOPIC
#define MQTT_TELEMETRY_TOPIC ENV_MQTT_TELEMETRY_TOPIC
#else
#define MQTT_TELEMETRY_TOPIC CONFIG_CSI_MQTT_TELEMETRY_TOPIC
#endif
#ifdef ENV_ROOM_ID
#define ROOM_ID ENV_ROOM_ID
#else
#define ROOM_ID CONFIG_CSI_ROOM_ID
#endif
#ifdef ENV_DEVICE_ID
#define DEVICE_ID ENV_DEVICE_ID
#else
#define DEVICE_ID CONFIG_CSI_DEVICE_ID
#endif
#ifdef ENV_SENDER_MAC
#define SENDER_MAC ENV_SENDER_MAC
#else
#define SENDER_MAC CONFIG_CSI_SENDER_MAC
#endif
#ifdef ENV_CSI_SOURCE
#define CSI_SOURCE ENV_CSI_SOURCE
#elif CONFIG_CSI_SOURCE_SENDER
#define CSI_SOURCE "sender"
#else
#define CSI_SOURCE "router"
#endif
#ifdef ENV_SNTP_SERVER
#define SNTP_SERVER ENV_SNTP_SERVER
#else
#define SNTP_SERVER CONFIG_CSI_SNTP_SERVER
#endif

#define FIRMWARE_VERSION "0.1.0"
#define WIFI_CONNECTED_BIT BIT0

static const char *TAG = "csi_receiver";

static EventGroupHandle_t s_wifi_events;
static esp_mqtt_client_handle_t s_mqtt;
static volatile bool s_mqtt_connected;

static char s_topic_telemetry[96];
static char s_topic_heartbeat[96];
static char s_topic_cmd[96];
static char s_topic_status[96];

/* ---------------------------------------------------------------- helpers */

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
    return true;
}

/* Unix time in ms, or 0 if SNTP has not synced yet (backend then uses its own clock). */
static int64_t now_ms(void)
{
    struct timeval tv;
    gettimeofday(&tv, NULL);
    if (tv.tv_sec < 1700000000) {
        return 0;
    }
    return (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
}

static void publish(const char *topic, const char *payload, int qos)
{
    if (!s_mqtt_connected) {
        return;
    }
    esp_mqtt_client_publish(s_mqtt, topic, payload, 0, qos, 0);
}

/* ---------------------------------------------------------------- CSI callbacks */

/* ISO 8601 UTC with milliseconds as a JSON value, e.g. "2026-09-23T12:53:20.921Z",
 * or null if the clock has not synced yet. */
static void iso_timestamp_json(int64_t ms, char *out, size_t len)
{
    if (ms == 0) {
        strlcpy(out, "null", len);
        return;
    }
    time_t secs = ms / 1000;
    struct tm tm_utc;
    gmtime_r(&secs, &tm_utc);
    char base[24];
    strftime(base, sizeof(base), "%Y-%m-%dT%H:%M:%S", &tm_utc);
    snprintf(out, len, "\"%s.%03dZ\"", base, (int)(ms % 1000));
}

/* Local wall-clock time for log lines, e.g. "20:53:20", or "--:--:--" before sync. */
static void local_clock(int64_t ms, char *out, size_t len)
{
    if (ms == 0) {
        strlcpy(out, "--:--:--", len);
        return;
    }
    time_t secs = ms / 1000;
    struct tm tm_local;
    localtime_r(&secs, &tm_local);
    strftime(out, len, "%H:%M:%S", &tm_local);
}

static void on_window(const csi_window_t *w)
{
    int64_t ts = now_ms();
    char iso[40];
    iso_timestamp_json(ts, iso, sizeof(iso));

    /* motion_excess is null until calibrated (no noise floor to subtract yet). */
    char excess[16];
    if (w->calibrated) {
        snprintf(excess, sizeof(excess), "%.3f", w->motion_excess);
    } else {
        strlcpy(excess, "null", sizeof(excess));
    }

    char json[352];
    snprintf(json, sizeof(json),
             "{\"device_id\":\"%s\",\"room_id\":\"%s\",\"ts\":%" PRId64 ",\"timestamp\":%s"
             ",\"motion_score\":%.3f,\"motion_excess\":%s,\"motion_max\":%.3f,\"baseline_diff\":%.3f"
             ",\"rssi\":%d,\"packet_rate\":%d,\"calibrated\":%s}",
             DEVICE_ID, ROOM_ID, ts, iso,
             w->motion_score, excess, w->motion_max, w->baseline_diff,
             w->rssi, w->packet_rate, w->calibrated ? "true" : "false");
    publish(s_topic_telemetry, json, 1);

#if CONFIG_CSI_LOG_WINDOWS
    char clock[16];
    local_clock(ts, clock, sizeof(clock));
    ESP_LOGI(TAG, "%s rate=%3d rssi=%d motion=%.2f excess=%.2f max=%.2f base_diff=%.2f sc=%d%s%s",
             clock, w->packet_rate, w->rssi, w->motion_score, w->motion_excess, w->motion_max,
             w->baseline_diff,
             w->valid_subcarriers, w->calibrated ? "" : " (uncalibrated)",
             s_mqtt_connected ? "" : " [mqtt offline]");
#endif
}

static void on_calibration_done(bool ok, int subcarriers, uint32_t packets, float noise_floor)
{
    char json[224];
    snprintf(json, sizeof(json),
             "{\"device_id\":\"%s\",\"ts\":%" PRId64 ",\"event\":\"%s\",\"subcarriers\":%d"
             ",\"packets\":%" PRIu32 ",\"noise_floor\":%.3f}",
             DEVICE_ID, now_ms(), ok ? "calibration_done" : "calibration_failed",
             subcarriers, packets, noise_floor);
    publish(s_topic_status, json, 0);
}

/* ---------------------------------------------------------------- MQTT */

static void handle_command(const char *data, int len)
{
    char buf[256];
    if (len <= 0 || len >= (int)sizeof(buf)) {
        ESP_LOGW(TAG, "Ignoring command of length %d", len);
        return;
    }
    memcpy(buf, data, len);
    buf[len] = '\0';
    ESP_LOGI(TAG, "Command received: %s", buf);

    /* Minimal parsing so we don't depend on cJSON (moved out of IDF in v6). */
    const char *cmd = strstr(buf, "\"cmd\"");
    if (cmd == NULL || strstr(cmd, "\"calibrate\"") == NULL) {
        ESP_LOGW(TAG, "Unknown command");
        return;
    }

    int seconds = 60;
    const char *sec = strstr(buf, "\"seconds\"");
    if (sec) {
        sec = strchr(sec + 9, ':');
        if (sec) {
            seconds = (int)strtol(sec + 1, NULL, 10);
        }
    }

    esp_err_t err = csi_processor_request_calibration(seconds);
    char json[160];
    snprintf(json, sizeof(json),
             "{\"device_id\":\"%s\",\"ts\":%" PRId64 ",\"event\":\"%s\",\"seconds\":%d}",
             DEVICE_ID, now_ms(),
             err == ESP_OK ? "calibration_started" : "calibration_busy", seconds);
    publish(s_topic_status, json, 0);
}

static void mqtt_event_handler(void *args, esp_event_base_t base, int32_t event_id, void *event_data)
{
    esp_mqtt_event_handle_t event = event_data;
    switch ((esp_mqtt_event_id_t)event_id) {
    case MQTT_EVENT_CONNECTED:
        s_mqtt_connected = true;
        ESP_LOGI(TAG, "MQTT connected, subscribing to %s", s_topic_cmd);
        esp_mqtt_client_subscribe(s_mqtt, s_topic_cmd, 1);
        break;
    case MQTT_EVENT_DISCONNECTED:
        s_mqtt_connected = false;
        ESP_LOGW(TAG, "MQTT disconnected (will retry automatically)");
        break;
    case MQTT_EVENT_DATA:
        if (event->topic_len == (int)strlen(s_topic_cmd) &&
                strncmp(event->topic, s_topic_cmd, event->topic_len) == 0) {
            handle_command(event->data, event->data_len);
        }
        break;
    case MQTT_EVENT_ERROR:
        ESP_LOGW(TAG, "MQTT error - check the broker URL and that the broker allows LAN connections");
        break;
    default:
        break;
    }
}

static void mqtt_start(void)
{
    esp_mqtt_client_config_t cfg = {
        .broker.address.uri = MQTT_BROKER_URL,
        .credentials.client_id = DEVICE_ID,
    };
    if (strlen(MQTT_USERNAME) > 0) {
        cfg.credentials.username = MQTT_USERNAME;
        cfg.credentials.authentication.password = MQTT_PASSWORD;
    }
    s_mqtt = esp_mqtt_client_init(&cfg);
    ESP_ERROR_CHECK(esp_mqtt_client_register_event(s_mqtt, (esp_mqtt_event_id_t)ESP_EVENT_ANY_ID,
                                                   mqtt_event_handler, NULL));
    ESP_ERROR_CHECK(esp_mqtt_client_start(s_mqtt));
}

static void heartbeat_task(void *arg)
{
    for (;;) {
        char json[160];
        snprintf(json, sizeof(json),
                 "{\"device_id\":\"%s\",\"ts\":%" PRId64 ",\"uptime_s\":%" PRId64 ",\"firmware\":\"%s\"}",
                 DEVICE_ID, now_ms(), esp_timer_get_time() / 1000000, FIRMWARE_VERSION);
        publish(s_topic_heartbeat, json, 0);
        vTaskDelay(pdMS_TO_TICKS(CONFIG_CSI_HEARTBEAT_INTERVAL_S * 1000));
    }
}

/* ---------------------------------------------------------------- Wi-Fi */

static void wifi_event_handler(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        wifi_event_sta_disconnected_t *d = data;
        xEventGroupClearBits(s_wifi_events, WIFI_CONNECTED_BIT);
        if (d->reason == WIFI_REASON_NO_AP_FOUND) {
            ESP_LOGW(TAG, "Network '%s' not found (is it 2.4 GHz and in range?), retrying...", WIFI_SSID);
        } else if (d->reason == WIFI_REASON_AUTH_EXPIRE || d->reason == WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT ||
                   d->reason == WIFI_REASON_HANDSHAKE_TIMEOUT || d->reason == WIFI_REASON_AUTH_FAIL) {
            ESP_LOGW(TAG, "Rejected by '%s' (reason %d) - usually a WRONG PASSWORD, or the network "
                     "requires WPA3-only. Check WIFI_PASSWORD in .env. Retrying...", WIFI_SSID, d->reason);
        } else {
            ESP_LOGW(TAG, "Wi-Fi disconnected (reason %d), reconnecting...", d->reason);
        }
        vTaskDelay(pdMS_TO_TICKS(1000));
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *e = data;
        ESP_LOGI(TAG, "Got IP " IPSTR, IP2STR(&e->ip_info.ip));
        xEventGroupSetBits(s_wifi_events, WIFI_CONNECTED_BIT);
    }
}

static void wifi_init(void)
{
    s_wifi_events = xEventGroupCreate();
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event_handler, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event_handler, NULL));

    wifi_config_t wifi_config = {0};
    strlcpy((char *)wifi_config.sta.ssid, WIFI_SSID, sizeof(wifi_config.sta.ssid));
    strlcpy((char *)wifi_config.sta.password, WIFI_PASSWORD, sizeof(wifi_config.sta.password));
    /* Accept WPA2 and WPA3 networks. Zero-initialising the struct would select
     * the legacy WPA3 handshake only, which phone hotspots often reject. */
    wifi_config.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;
    wifi_config.sta.sae_pwe_h2e = WPA3_SAE_PWE_BOTH;
    wifi_config.sta.pmf_cfg.required = false;

    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config));
    ESP_ERROR_CHECK(esp_wifi_start());
    /* Power save would make the radio miss most of the measured packets. */
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));
}

/* Router mode: ping the gateway continuously; CSI is measured on its replies. */
static void router_ping_start(void)
{
    esp_netif_ip_info_t ip_info;
    esp_netif_t *netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    ESP_ERROR_CHECK(esp_netif_get_ip_info(netif, &ip_info));

    esp_ping_config_t cfg = ESP_PING_DEFAULT_CONFIG();
    cfg.count = ESP_PING_COUNT_INFINITE;
    cfg.interval_ms = 1000 / CONFIG_CSI_ROUTER_PING_HZ;
    cfg.timeout_ms = 1000;
    cfg.data_size = 1;
    cfg.target_addr.type = IPADDR_TYPE_V4;
    cfg.target_addr.u_addr.ip4.addr = ip_info.gw.addr;

    esp_ping_callbacks_t cbs = {0};
    esp_ping_handle_t ping;
    ESP_ERROR_CHECK(esp_ping_new_session(&cfg, &cbs, &ping));
    ESP_ERROR_CHECK(esp_ping_start(ping));
    ESP_LOGI(TAG, "Pinging router " IPSTR " at %d Hz", IP2STR(&ip_info.gw), CONFIG_CSI_ROUTER_PING_HZ);
}

static void sntp_sync(void)
{
    esp_sntp_config_t config = ESP_NETIF_SNTP_DEFAULT_CONFIG(SNTP_SERVER);
    esp_netif_sntp_init(&config);
    if (esp_netif_sntp_sync_wait(pdMS_TO_TICKS(15000)) == ESP_OK) {
        ESP_LOGI(TAG, "Time synced via SNTP");
    } else {
        ESP_LOGW(TAG, "SNTP sync timed out; ts will be 0 until it syncs (backend uses its own clock)");
    }
}

/* ---------------------------------------------------------------- main */

void app_main(void)
{
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    /* Local time zone for log lines only; telemetry timestamps are UTC. */
    setenv("TZ", CONFIG_CSI_LOG_TIMEZONE, 1);
    tzset();

    strlcpy(s_topic_telemetry, MQTT_TELEMETRY_TOPIC, sizeof(s_topic_telemetry));
    snprintf(s_topic_heartbeat, sizeof(s_topic_heartbeat), "devices/%s/heartbeat", DEVICE_ID);
    snprintf(s_topic_cmd, sizeof(s_topic_cmd), "devices/%s/cmd", DEVICE_ID);
    snprintf(s_topic_status, sizeof(s_topic_status), "devices/%s/status", DEVICE_ID);

    bool router_mode = strcmp(CSI_SOURCE, "sender") != 0;
    ESP_LOGI(TAG, "CSI source: %s", router_mode ? "ROUTER (one ESP32, pinging the router)"
                                                : "SENDER board (two ESP32s)");

    wifi_init();
    ESP_LOGI(TAG, "Connecting to SSID '%s'...", WIFI_SSID);
    xEventGroupWaitBits(s_wifi_events, WIFI_CONNECTED_BIT, pdFALSE, pdTRUE, portMAX_DELAY);

    wifi_ap_record_t ap = {0};
    ESP_ERROR_CHECK(esp_wifi_sta_get_ap_info(&ap));

    uint8_t mac[6];
    const uint8_t *mac_filter = NULL;
    if (router_mode) {
        /* The router's replies carry its BSSID as the source MAC. */
        memcpy(mac, ap.bssid, sizeof(mac));
        mac_filter = mac;
        ESP_LOGI(TAG, "Accepting CSI only from router " MACSTR " (channel %d)", MAC2STR(mac), ap.primary);
    } else {
        ESP_LOGI(TAG, "==================================================");
        ESP_LOGI(TAG, "AP channel is %d - set the SENDER to channel %d", ap.primary, ap.primary);
        ESP_LOGI(TAG, "==================================================");
        if (strlen(SENDER_MAC) == 0) {
            ESP_LOGW(TAG, "SENDER_MAC is empty: accepting CSI from ANY transmitter (bring-up mode)");
        } else if (parse_mac(SENDER_MAC, mac)) {
            mac_filter = mac;
            ESP_LOGI(TAG, "Accepting CSI only from sender " MACSTR, MAC2STR(mac));
        } else {
            ESP_LOGE(TAG, "Invalid SENDER_MAC '%s'. Accepting any sender.", SENDER_MAC);
        }
    }

    ESP_ERROR_CHECK(csi_processor_start(mac_filter, on_window, on_calibration_done));
    /* Promiscuous RX is only needed to hear the sender's ESP-NOW broadcasts. */
    ESP_ERROR_CHECK(csi_processor_enable_wifi_csi(!router_mode));
    if (router_mode) {
        router_ping_start();
    }
    sntp_sync();
    mqtt_start();
    xTaskCreate(heartbeat_task, "heartbeat", 3072, NULL, 3, NULL);

    ESP_LOGI(TAG, "Receiver running: room=%s device=%s firmware=%s",
             ROOM_ID, DEVICE_ID, FIRMWARE_VERSION);
}
