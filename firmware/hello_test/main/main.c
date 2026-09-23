/* Minimal upload test: prints chip info and a counter every second. */
#include <stdio.h>
#include <inttypes.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_chip_info.h"
#include "esp_mac.h"

void app_main(void)
{
    esp_chip_info_t chip;
    esp_chip_info(&chip);

    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_STA);

    printf("\n=== Upload test OK! ===\n");
    printf("Chip: ESP32-S3, %d cores, revision %d\n", chip.cores, chip.revision);
    printf("Wi-Fi MAC: " MACSTR "\n", MAC2STR(mac));

    for (uint32_t i = 0;; i++) {
        printf("Hello from ESP32-S3! count=%" PRIu32 "\n", i);
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}
