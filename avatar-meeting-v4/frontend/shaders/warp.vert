#version 300 es
precision highp float;

in vec2 a_position;
in vec2 a_texCoord;
in vec2 a_displacement;

out vec2 v_texCoord;

void main() {
    vec2 pos = a_position + a_displacement;
    gl_Position = vec4(pos, 0.0, 1.0);
    v_texCoord = a_texCoord;
}
