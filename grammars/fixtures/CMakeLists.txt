cmake_minimum_required(VERSION 3.24)
project(poly VERSION 0.2.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
option(POLY_BUILD_TESTS "Build the test suite" ON)

find_package(Threads REQUIRED)

file(GLOB_RECURSE POLY_SOURCES CONFIGURE_DEPENDS src/*.cpp)

add_library(poly_core STATIC ${POLY_SOURCES})
target_include_directories(poly_core PUBLIC include)
target_link_libraries(poly_core PUBLIC Threads::Threads)

if(MSVC)
  target_compile_options(poly_core PRIVATE /W4 /permissive-)
else()
  target_compile_options(poly_core PRIVATE -Wall -Wextra -Wpedantic)
endif()

if(POLY_BUILD_TESTS)
  enable_testing()
  foreach(name IN ITEMS detect walk fmt)
    add_executable(test_${name} tests/${name}.cpp)
    target_link_libraries(test_${name} PRIVATE poly_core)
    add_test(NAME ${name} COMMAND test_${name})
  endforeach()
endif()

install(TARGETS poly_core ARCHIVE DESTINATION lib)
