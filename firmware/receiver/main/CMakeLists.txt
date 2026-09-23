# No REQUIRES list: the main component may use every component, which lets the
# same project build on ESP-IDF v5.x (built-in mqtt) and v6.x (managed mqtt).
idf_component_register(SRCS "main.c" "csi_processor.c"
                       INCLUDE_DIRS ".")

# Settings from the repo-root .env override menuconfig (see .env.example).
set(env_file "${CMAKE_CURRENT_LIST_DIR}/../../../.env")
set(env_header_dir "${CMAKE_CURRENT_BINARY_DIR}/generated")
idf_build_get_property(python PYTHON)
execute_process(
    COMMAND ${python} "${CMAKE_CURRENT_LIST_DIR}/env_to_header.py" "${env_file}" "${env_header_dir}/env_config.h"
    RESULT_VARIABLE env_result)
if(NOT env_result EQUAL 0)
    message(FATAL_ERROR "Failed to read ${env_file}")
endif()
# Re-run configuration whenever .env (or the generator) changes.
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
             "${CMAKE_CURRENT_LIST_DIR}/env_to_header.py")
if(EXISTS "${env_file}")
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${env_file}")
endif()
target_include_directories(${COMPONENT_LIB} PRIVATE "${env_header_dir}")
